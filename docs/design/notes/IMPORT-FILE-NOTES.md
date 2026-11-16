# Importing files, scanning with the camera, and deleting the export afterwards

Revision 2 follows an independent review of revision 1 (its report, IMPORTFILE-REVIEW.md, is not part of the tree).
What changed, finding by finding, is §9. Revision 3 follows the re-review of revision 2 (IMPORTFILE-REREVIEW.md, not in
the tree either): §10.

Settings › Add account had no way to open a file. A plain list of `otpauth://` links exported by another app (for
example `authenticator-uris-<date>.txt`, one link per line) could be imported only by pasting it, or through Backup's
"Import a backup", which few would look for. This change adds three things to the page, all in the settings tab:

- **Choose file** and a drop zone, for exports in text, JSON or CSV, and for QR images;
- **Scan with camera**, for a single QR code and for Google Authenticator's export of several codes;
- after the accounts are added, the question **"delete the file now?"**.

Everything goes through the page's existing confirmation step: the preview, then Add. Nothing is added until then.
The popup is unchanged.

## 1. The page

- **The paste box** works as before.
- **The drop zone** holds three things:
  - **Choose file**: the browser's own file picker (`showOpenFilePicker`), which hands back a handle, so the file can
    be deleted later. Where the picker is missing or fails, the hidden `<input type=file>` (`#qr-file`) is used, which
    gives no handle. After one failure every later click goes straight to the input, while the click still counts as
    the user's.
  - **Scan with camera**.
  - A line naming what it reads.
  A file dropped anywhere on the paste box is read. A file dropped anywhere else on the page is ignored, so that
  Chrome does not open a plain-text export as a page of its own.
- **Each file read is listed by its name** (`#add-files`), with what was found or why nothing was. The file's keys are
  never put in the paste box or anywhere else on screen. The preview shows issuers and account names only, as before.
- **The codes the camera reads** are a row of their own in that list ("Camera · 3"), like a file's, and are never written
  into the paste box either.
- **Add** with nothing to add says what to do ("Paste links, choose a file or scan a QR code first"), not "Add 0
  accounts".
- **Cancel** drops everything read so far.
- **A lock** drops the same, wherever it comes from: the paste box, the files' and the camera's accounts and the column
  choice. Until this change, pasted text stayed in the box on a locked page. A locked page takes no file, its paste box
  is disabled, and its camera button is off.
- **The Google Authenticator card's steps**:
  1. Transfer accounts › Export accounts, which shows one or more codes;
  2. scan each one here, or choose or drop screenshots of them;
  3. afterwards, delete the screenshots and files.
- **The Backup section** hands every file that is not a Sixkey backup to Add account, the File object and not its text
  (`src/options/import-handoff.ts`): exports of any format, encrypted ones, ZIPs, UTF-16 text, images. Add account then
  says what it is. A file over 5 MiB is not read by Backup at all. This replaces the old trick of writing the file's
  text into the paste box. Backup says "Loaded into the Add accounts box above"; only when Add account is not on the
  page (locked) does it say "This is not a Sixkey backup file". Backup's text now says where other apps' exports go.

## 2. What a file is (`src/core/import/file-text.ts`)

What a file is comes from its bytes, never from its name or extension.

- **Images.** PNG, JPEG, GIF, WebP and BMP are recognised by their magic numbers and go to the existing QR reader
  (`src/lib/qr.ts`: BarcodeDetector where Chrome has it, the `qr` package otherwise). Images are capped at 20 MiB.
- **ZIP archives** (`PK\3\4`) are refused with "unzip it first". A Raivo export is a password-protected ZIP.
- **Text** must be 5 MiB or less. It can be:
  - UTF-8, with or without a byte order mark;
  - UTF-16, either byte order, with a byte order mark or without one. Without one it is recognised by the zero bytes
    on one side.
- **Binary** is anything else: UTF-32, a NUL, or more than 2% control characters or undecodable bytes in the first
  64 KiB. A binary file whose name ends in `.aes` is called an encrypted andOTP backup. That format has no marker in
  its bytes, so its name is the only clue. The name is used for that message only.

The bytes and the text exist only inside `readPicked` (`src/options/import-read.ts`). What is kept until the import is
added or cancelled:

- the checked links;
- the file's name, size and time, and the SHA-256 of its bytes (for the delete prompt, §5);
- its handle, if there is one;
- how many of its entries were not taken (for the delete prompt).

## 3. Formats (`src/core/import/file-formats.ts`)

Every account a file holds becomes one `otpauth://` line and is checked by the same parsers as the paste box
(`parseOtpauth`, `parseMigrationUri`). Only lines that parse reach the importer. Every other entry is listed under its
file:

- its position (line or entry number);
- its name: the issuer and account, never another field;
- a reason.

These are tried in order:

1. **JSON** (the text starts with `{` or `[`).
   - The text is first scanned once, outside strings, for nesting deeper than 64. Deeper text is not parsed.
   - The parser's error message is never shown, because V8 quotes the input in it.
   - Formats are recognised by structure.
2. **An OpenPGP message** (`-----BEGIN PGP MESSAGE-----`): encrypted, not opened. It is named "andOTP (OpenPGP)", the
   one authenticator export known to write one.
3. **A web page** (markup at the start: `<!doctype html`, `<html`, `<head>`, `<body>`, `<img>` or `<table>` in its first
   4 KiB, after a comment too) with no link text in it: "a web page export: its codes are
   only pictures; scan them with the camera, or choose screenshots of them". Ente's and Raivo's HTML exports hold their
   codes as QR images only (the review read `html_export.dart` and Raivo's templates); revision 1's claim that their
   links are read was false. A page that does hold `otpauth://` text is read as a list of links.
4. **CSV with a header** that has a column of 2FA keys:
   - a column named for one (`totp`, `login_totp`, `otpauth`, `otp_url`, `otpSecret`, `secret`, `seed`, `key`, …), or
     a column whose cells are links, whatever its name;
   - never a website column (`url`, `uri`): password managers put the site there, before their TOTP column;
   - each row takes the first of those cells with something in it: a link, or, in a column named for a key, a bare key;
   - read by column name, so the order does not matter: KeePassXC (`TOTP`), LastPass (`totp`), Proton Pass (`totp`),
     Dashlane (`otpSecret`), 1Password (`OTPAuth`) and Bitwarden (`login_totp`), plus the issuer and account columns
     (`name`/`title`, `username`/`email`/`login`) and the algorithm, digits, period, OTP type and counter columns;
   - no other column is ever looked at (a password, a note, a website);
   - a row with no key (a login without 2FA) is skipped silently;
   - `,`, `;` and tab are accepted as separators, with RFC 4180 quoting. A first line with a link on it is no header.
5. **A list of links**: `otpauth://`, `otpauth-migration://`, `steam://` and `motp://`, in any mix.
   - **A line that is a link** (once its surrounding quotes and trailing commas and semicolons are off) is taken
     **whole**, exactly as the paste box takes it. An issuer written `Lowe's`, `Acme, Inc`, `A;B` or with a raw space
     keeps every parameter after it: Sixkey's own plain export (`encodeURIComponent` leaves `'` as it is) round-trips.
     A separator followed by another link (`linkA,linkB`, `linkA | linkB`, `"A", "B",`) starts the next one: every
     link of the line is read. A table cell that does not carry on the query (`…&period=30,MyPassword`: no `name=` in
     it) is cut off, so another column never becomes part of the link; and a link further along the line, after such
     a cell, is still read, never dropped.
   - **A word run into a secret** (`…?secret=K work`, `…&secret=K MyPassword`: white space, then more text, in the
     `secret` value as written) refuses the link as "secret key is not valid". Decoding would glue the word onto the
     key (`KWORK`); a real link writes a space in its key as `%20` or `+`, which stay allowed. The same check runs on
     the paste box's links.
   - **A link inside a line** (a sentence, a table row, markup) ends at white space, a quote, `<`, `>`, `,`, `;` or `|`.
     When the line goes on with a parameter (`&digits=8`) before the next link, the cut fell inside the link: it is
     refused as "could not be read", never imported without the rest of its parameters.
   - `&amp;`, `&#38;` and `&#x26;` between parameters (a saved web page, an e-mail) are read as `&`, here and in the
     paste box, however many times they were escaped (`&amp;amp;`, decoded until it no longer changes, at most four
     times; a link still escaped after that is refused).
   - Links run together are split.
   - Blank lines, CRLF, CR, comments (`#`, `//`) and lines of only brackets are tolerated.
   - Any other line is reported as "not a link or a key".
6. **Plain key lines**: a key on its own, or `name|key`. They go to the paste box's own rules (H7, the column choice),
   and only when at least one line reads as a key. Otherwise the file holds nothing.

| Export                                  | Recognised by                                                                       | Read                                                                                                                      | Encrypted form                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Aegis (plain vault export)              | `header` with `slots`, and `db`                                                     | `db.entries[]`: `type`, `issuer`, `name`, `info.secret`/`algo`/`digits`/`period`/`counter`; not `note`, `icon`, `groups`  | `db` a string, or `header.slots` an array: "encrypted Aegis export"                                |
| 2FAS (`.2fas`)                          | `services` and `schemaVersion`, `servicesEncrypted`, `appVersionCode` or `otp`      | `name` (issuer, else `otp.issuer`), `otp.account`, `secret`, `otp.digits`/`period`/`algorithm`/`tokenType`/`counter`      | `servicesEncrypted` a non-empty string                                                             |
| andOTP (plain)                          | a bare array of objects that all have `secret`                                      | `secret` (padding allowed), `issuer`, `label`, `type`, `algorithm`, `digits`, `period`, `counter`; not `tags`, thumbnails | `.json.aes`: binary (see §2); `.json.gpg`: OpenPGP                                                 |
| Raivo (the JSON inside its ZIP)         | a bare array with `kind` or `timer`                                                 | `issuer`, `account`, `secret`, `algorithm`, `digits`, `kind`, `timer`, `counter` (all strings)                            | the ZIP itself (password protected): "unzip it first"                                              |
| Bitwarden JSON                          | `encrypted` (a boolean) and `items`, `data` or `encKeyValidation_DO_NOT_EDIT`       | `items[].login.totp` only (a link, a bare key as SHA-1/6/30, or `steam://`), with `name` and `login.username`             | `encrypted: true` (account key or password protected)                                              |
| Password-manager CSV                    | a key column (see 4.)                                                               | the key column, the name and account columns, and the OTP parameter columns                                               | none                                                                                               |
| FreeOTP+ JSON                           | `tokens[]` with a byte-list `secret`                                                | `secret` (signed bytes), `issuerExt`, `label`, `type`, `algo`, `digits`, `period`, `counter`                              | none                                                                                               |
| Proton Authenticator                    | `entries[].content`                                                                 | `content.uri`, `content.name`; `entry_type: Steam` counted as Steam                                                       | `salt` and a string `content`, no `entries`                                                        |
| Ente Auth                               | its plain export is a link list (row "list of links")                               | the links; its `codeDisplay` parameter is ignored by the link parser                                                      | `kdfParams` and `encryptedData`                                                                    |
| Sixkey backup                           | `format: "sixkey-backup"`                                                           | nothing: "this is a Sixkey backup, import it under Backup", with a link there                                             | (it is always encrypted)                                                                           |
| any other JSON                          | none of the above                                                                   | every link string anywhere, and every object whose `secret` is a key of 16 base32 characters or more (see below)          | none detected                                                                                      |

**Kinds Sixkey cannot make codes for** are counted by kind and reported as "N skipped: Sixkey cannot make Steam
codes". They are never taken as a TOTP:

- Steam, whether written as `type: steam`, `tokenType: STEAM`, `steam://`, `otpauth://steam/`, a FreeOTP+ token with
  issuer Steam, or an `otpauth://totp/…&encoder=steam` link. The `encoder` parameter is read as the importer reads
  parameters, so `encoder=%73team` and `encoder=steam+` are Steam too, in files and in the paste box;
- mOTP, also as Aegis's `motp://` link;
- Yandex;
- any other kind. It is named as written, if it reads as a short name, and is otherwise an unsupported type.

**Parameters the parser does not accept** (5 or 7 digits, MD5, a period outside 1 to 86400) skip the entry with
that reason.

**A parameter that is there but cannot be read refuses the entry**, as "could not be read". It is never given the
default: `digits: true`, `[8]`, an object, `1e400` (Infinity once parsed), a list for `algo`. `null`, an empty string
and a missing field take the format's default (2FAS writes `algorithm: null` for SHA-1).

**Any other JSON**, and a list of account objects (andOTP, Raivo and alike): an object whose `secret` is shaped like a
key is an account, read by the usual field names. Its parameters are read from the object itself, or from one
sub-object named for them: `otp`, `totp`, `hotp`, `info`, `token`, `params`, `parameters`, `otpParams` (as 2FAS and
Aegis do). A key that sets the codes (digits, period, interval, step, timer, algorithm, counter) in any other
sub-object, or deeper down, refuses the object: `{secret, sync: {interval: 300}}` is a sync interval, not a period, and
round 2 took it for one. So do parameters in two places that differ, and two such sub-objects. In a file of no known
format, a period outside 10 to 300 seconds refuses the object too; a list of accounts keeps the period its app let the
user set. An unrelated `type` (`icon: {type: "png"}`) neither refuses the account nor names a kind.

**Lone surrogates** in a name (`"\ud800"` in JSON) are replaced, so `encodeURIComponent` cannot throw; the entry
points also have a backstop that returns "no accounts" rather than throw.

**HOTP is imported as HOTP, with its counter**, not skipped and never as a TOTP.

- Sixkey stores and backs up HOTP accounts (`otpauth.ts` parses them; the vault keeps `type` and `counter`), and the
  paste box always imported them, with the note "N counter-based account(s) will be kept but cannot generate codes
  yet".
- A file follows the paste box, so the same account imports the same way however it arrives. An export that leaves
  out a HOTP counter starts it at 0, as Aegis's own importer does.
- If HOTP should instead be skipped until Sixkey makes HOTP codes, the change is one line in `otherKind`. That is the
  owner's call. The review accepted the choice on one condition, now met: the delete prompt names how many of the
  file's accounts came in as HOTP (§5).
- A FreeOTP+ JSON token's counter is taken as written. FreeOTP+'s link export writes `counter + 1` instead, so the same
  account can come in one count apart, depending on the file. Which is the next counter is [unverified]; it matters
  only once Sixkey makes HOTP codes.

**Bounds.** The reader never throws, and no scan in it is quadratic: trailing punctuation is trimmed by a loop (a
regular expression there took 50 s on one 300 KiB line in revision 1), a link's cut is checked against the line's
parameter positions found once, and every other expression is linear. A test holds a 5 MiB single line and 300,000
closing brackets inside the line cap to under a second each. Its caps:

| What                                                        | Cap               | What happens over it          |
| ----------------------------------------------------------- | ----------------- | ----------------------------- |
| physical lines                                              | 200,000           | the file is too large         |
| accounts per file (`LIMITS.entries`, the vault's own limit) | 5,000             | the file is too large         |
| plain key lines                                             | 5,000             | the file is too large         |
| one line                                                    | 300 KiB           | skipped unread, "too large"   |
| JSON depth                                                  | 64                | the file holds nothing        |
| JSON values walked                                          | 200,000           | the file is too large         |
| codes in one Google export (`migration.ts` `MAX_BATCH_SIZE`)  | 1,000             | the code cannot be read       |
| skip records kept                                           | 5,000             | the rest are not listed       |

The screen lists the first 8 skip records and then "+N".

**Sources.** Read through the apps' own source code or a mature importer:

- Aegis: `docs/vault.md` and its importers (`TwoFASImporter`, `AndOtpImporter`, `BitwardenImporter`,
  `FreeOtpPlusImporter`, `ProtonAuthenticatorImporter`, `EnteAuthImporter`), with the test fixtures:
  `https://github.com/beemdevelopment/Aegis`
- 2FAS: `BackupContent.kt` and the iOS `ExchangeData2.swift`; `https://github.com/twofas/2fas-android`,
  `https://github.com/twofas/2fas-ios`
- andOTP: `Entry.java`, `BackupActivity.java`, `EncryptionHelper.java`; `https://github.com/andOTP/andOTP`
- Raivo: `DataExportFeature.swift`, `Password.swift`; `https://github.com/raivo-otp/ios-application`
- Bitwarden: the export types and importers in `https://github.com/bitwarden/clients`, and `totp.rs` in
  `https://github.com/bitwarden/sdk-internal`
- FreeOTP+: `https://github.com/helloworld1/FreeOTPPlus`
- Ente Auth: `https://github.com/ente-io/ente`, including `docs/docs/auth/migration/export.md`
- Authy has no export: `https://support.twilio.com/hc/en-us/articles/19753420684059`

The fixtures in `test/helpers/import-fixtures.ts` are synthetic: made-up keys, in the shapes those sources show. No
file exported by a real app was imported. That a current version of each app writes exactly these shapes is
[unverified] against real exports. Also [unverified]:

- the OpenPGP armour header of andOTP's `.gpg` export, which is taken from the armour standard;
- the Bitwarden `kdfType` numbers, which are not read and do not matter here;
- the `.txt` extension of Ente's plain export, which does not matter either: the content decides.

**Not supported, and why:**

- **Encrypted exports.** Sixkey opens no other app's encryption:
  - Aegis, 2FAS, andOTP `.aes`/`.gpg`, Bitwarden, Proton, Ente and OpenPGP files are recognised and named, with "export
    again without encryption";
  - an encrypted file of an app not listed is "No accounts found".
- **Authy** has no export. Use its accounts' sites to set up 2FA again.
- **Microsoft Authenticator** has no export either.
- **ZIP archives.**
- **HTML exports** (Ente's HTML export, Raivo's HTML page) hold their codes as QR images only, and are explained (see
  3.): their screenshots, or the camera, read them.
- **Notes, icons, groups, tags, favourites and usage counts** of every format are dropped.
- **HOTP codes**: see above.

## 4. The camera (`src/platform/camera.ts`, `src/options/AddCamera.tsx`, `src/core/import/scan-batch.ts`)

- **The call.** `getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width/height ideal
  1280×720 } })` runs in the settings tab. The preview's `srcObject` is set directly: no blob URL, nothing recorded.
- **Chrome's prompt and the popup.**
  - Chrome asks once for the extension's own origin, and the prompt names the extension.
  - No manifest permission exists or is needed for this. `manifest.base.json` and `scripts/check-dist.mjs` are
    unchanged, as are the CSP, which says nothing about media from a stream, and the page policies.
  - The toolbar popup gets no camera prompt (a Chrome extensions team member, chromium-extensions group, January 2024:
    `https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM`; also
    `https://github.com/GoogleChrome/chrome-extensions-samples/issues/821`). So the camera is on the settings page only,
    and the popup's "Add account" entries already open the settings page (`#add-upload`, `#add-google`).
  - "Allow this time" ends when the tab closes. After "Never allow", Chrome asks no more, and the camera must be allowed
    under the extension's site settings. The error text says so.
- **Frames.**
  - A frame is read every 140 ms at most, about seven a second, and never before the last one is decoded.
  - Each is taken as an `ImageBitmap` of at most 960 px on its longest side, handed to the existing decoder
    (`decodeAllQrFromBitmap`), and closed.
  - No frame is drawn anywhere else, stored or sent.
  - Measured with the `qr` package in Node on synthetic 800×450 frames with no code: 1 to 6 ms each.
- **One `otpauth://` code** ends the scan. The code joins the import as a row of its own ("Camera"), never written into
  the paste box (revision 1 wrote it there, on screen; a pasted QR screenshot still goes into the box, as before).
- **Every code is checked as a QR image's is** (`readQrTexts`, through `import-read.ts` `readScanned`): a Steam code
  (`encoder=steam`, as KeePassXC shows it), `&amp;`, a word run into the key. Only what that check takes joins the
  import, and the camera's row says what it refused ("1 skipped: Sixkey cannot make Steam codes"). Revision 2 passed
  the camera's codes to the importer unchecked, so a Steam code came in as a 6-digit TOTP.
- **A Google Authenticator export** shows several codes, each with `batch_size`, `batch_index` and `batch_id`.
  - The first export code read decides the export.
  - Each new code of it joins the camera's row, and the camera shows "Google export: 2 of 3 codes read. Still needed: 3."
  - A code read again changes nothing.
  - A code of another export (another `batch_id`, or another size) is refused: "This code is from another Google
    Authenticator export".
  - The scan ends when every code is in.
  - A scan restarted after Stop camera goes on from the codes already read and in the box (`seedScan`), as long as
    they are codes of exactly one unfinished export.
  - A code that says its export has more than 1,000 codes is no code (a hostile one claiming 2^31 froze the page).
- **Errors.**
  - A refusal (by the user, the system or a policy: `NotAllowedError`, `SecurityError`) says how to allow the camera:
    the camera icon in the address bar, the extension's site settings (after "Never allow" Chrome asks no more), and
    macOS's own camera setting.
  - Anything else (no camera, busy, broken) is "could not be started".
  - Both offer "Choose QR images" instead.
- **Every way out stops every track.** That is:
  - a code found;
  - Cancel;
  - an error after the stream opened;
  - the tab hidden (at once, with no grace period, because the preview cannot be seen anyway);
  - `pagehide`;
  - a lock from any page: the settings page already watches the lock epoch (`App.tsx`) and shows itself locked, and the
    camera's component then stops the camera. No second listener was added: the list of the pages' `storage.onChanged`
    listeners is held by `autofill-pre-source-rules.test.ts`;
  - the component unmounted.

  A stream that arrives after any of these is stopped as soon as it arrives (a generation number).

## 5. Deleting the file (`src/platform/file-access.ts`)

**When the prompt appears.** After an Add that added at least one account, and only for the files that brought in at
least one of the accounts just added (`offerDelete`). Never after a failure, a Cancel, or an import that added nothing
(all duplicates, say). Each file gets its own row: "<name> holds your secret keys in plain text. Delete it now?",
then "Deleting does not guarantee it cannot be recovered." The same holds for QR screenshots. There is no "don't ask
again".

**What deleting would lose is said.** A file some of whose entries were not imported (Steam, mOTP, Yandex, unreadable
entries, entries the importer refused) adds "N account(s) in it were not imported. Deleting the file loses them.", and
Keep it is then the first button. A file whose accounts came in as HOTP adds "N of its accounts are counter-based
(HOTP): Sixkey keeps them but cannot make their codes yet." Accounts it holds that were already in the vault are not
lost, and are not counted.

**With a handle** (Choose file through Chrome's picker, or a drop that gave one through
`DataTransferItem.getAsFileSystemHandle()`, which is asked for inside the drop event), the row has **Delete file** and
**Keep it**. On Delete file, for that row's handle only:

1. `requestPermission({mode: "readwrite"})` comes first, while the click still counts as the user's: Chrome needs the
   click to show its prompt. Anything but `granted` is "was not deleted".
2. `getFile()` is compared with the size and time read before, and its bytes with the SHA-256 of the bytes read
   before. If any differs, or the file is gone, it is "changed after Sixkey read it, so it was not deleted". A file
   replaced with the same size and time (`cp -p`, `touch -r`, a sync tool) is caught by the hash. Decision: Sixkey never
   deletes what it did not read; the user may have exported again. The hash stays in the page's memory with the prompt
   and goes with it; a small window between this check and `remove()` remains.
3. `remove()`.
   - A `NotAllowedError` or `SecurityError` counts as refused.
   - A `NotFoundError` counts as changed.
   - Anything else is a failure.

   Every outcome is said, and nothing throws.

**Without a handle** (the input fallback, a handed-over Backup file, a drop that gave none), the row asks no question
it offers no answer to: "<name> holds your secret keys in plain text. Delete it yourself: move it to the Trash or
Recycle Bin, then empty it." with Got it. When deleting did not work, the row says so, with the same instruction.

**Facts about Chrome:**

- `FileSystemHandle.remove()` shipped in Chrome 110, is non-standard, and works on local files, not only the private
  file system. Sources: `https://chromestatus.com/feature/6318478849998848`, MDN's `FileSystemHandle.remove`, and
  Chromium's commit for crbug 1114923.
- `showOpenFilePicker` and `getAsFileSystemHandle` arrived in Chrome 86.
- Sixkey's minimum was Chrome 120 when this was written (Chrome 140 since wave 1b of the plugin platform), and every call
  is feature-detected anyway.

**Limits, said honestly:**

- Deleting puts nothing in the Trash; it removes the file. On SSDs and APFS a removed file's blocks are not erased,
  so it may still be recoverable. The prompt says "does not guarantee".
- Copies elsewhere are not touched: a cloud-synced Downloads folder, a backup, the phone that made the screenshot.
- [unverified] that Chrome's picker opens from an extension page in a tab (`chrome-extension://`). No source mentions
  it, and the e2e cannot open the native picker. Where it fails, the page falls back to the `<input>`, which gives no
  handle.
- [unverified] the real permission prompt for a picked local file, and `remove()` on one. The e2e exercises a real
  handle of the extension's private file system (`navigator.storage`) through a stand-in picker: granted, refused,
  changed, kept.
- [unverified] that a drop from the macOS Finder gives a handle in an extension page.

These are owner checks (OWNER-CHECKLIST item 19).

## 6. The plan (`src/core/import/file-plan.ts`)

- **What goes into one import.** The paste box first, then each file's checked lines in the order the files were
  chosen, through the one importer (`planImport`). A Google export spread over several screenshots is put together as
  before.
- **Duplicates are judged by `dedupe.ts`'s rules** ("exists", "repeat") with its `keyBytes`, by the key's bytes and
  not its text, and against live accounts only (the trash does not count). The key bytes are computed once per account,
  so 5,000 lines against 5,000 accounts are planned in linear time; the plan runs on every keystroke in the box. A duplicate is an account whose key is in the vault, or earlier in this import, under the same
  issuer, and whose codes are the same (type, algorithm, digits, and the period of a TOTP; a HOTP counter is not
  compared).
  - The same key with other parameters gives other codes, so it is added (M6C-REVIEW m5's point, applied here).
  - The same key under another issuer is added, as the paste box always did.
  - The popup's confirm page keeps its own use of `dedupe.ts`, unchanged.
- **This changes what the paste box does on the settings page.**
  - An account whose key is in the vault under the same issuer is now a duplicate even under another account name, or
    with its key written in another case or spacing.
  - Before, only the same text of key, issuer and account counted.
- **The paste box is cleaned link by link** (`cleanBox`), each link keeping its line so line numbers do not move:
  - `&amp;` and its numeric spellings are read as `&` (before, `amp;digits` was no parameter, and the account got the
    default 6 digits and 30 s);
  - an `otpauth://totp/…` link whose `encoder` parameter says Steam, however it is spelled, is reported as an
    unsupported type. Before, it was taken as a 6-digit TOTP, with wrong codes.
- **Line numbers** in "Line N skipped" count the box's links and lines, then the files'. Skipped entries of a file are
  listed under the file, by its own line or entry number and name.
- **The importer and the popup.** `importer.ts`, `otpauth.ts` and `dedupe.ts` are not changed. `migration.ts` gains one
  check, the bound on `batch_size` (`MAX_BATCH_SIZE`, 1,000), which protects the popup's confirm page as well.

## 7. Rules, budgets and tests

**Source rules** (`test/unit/importfile-source-rules.test.ts`):

- The popup's module graph holds none of the new modules.
- The readers in `src/core` touch no browser API.
- Nothing new logs.
- `deletePicked` has one caller, the Delete click, and only `file-access.ts` calls `remove()` on a handle.
- Only the settings page's camera calls `getUserMedia`.

**Text.** 29 new keys in `scripts/i18n/importfile.py`, placed in the accounts part, and seven rewritten. `siteRemove`
(the popup's "Remove $1") is placed there too, for a row's remove button. The `pasteHelp` rewrite is in `c2.py`,
which already rewrote that key. No limit was raised.

Measured on the live tree with the side panel (SIDEPANEL) merged, before and after this patch:

| Measure                                     | Before (zh_CN) | After (zh_CN) | Limit  |
| ------------------------------------------- | -------------- | ------------- | ------ |
| settings-accounts                           | 1,445          | 2,454         | 3,072  |
| settings-backup                             | 1,151          | 1,169         | 3,072  |
| settings page, a vault (core, five, unlock) | 9,962          | 10,824        | 12,288 |
| settings page, every part                   | 10,485         | 11,345        | 12,288 |

**The popup.** Its code and catalogs are the same; only the names (and one minified export alias) of the lazy chunks
it shares with the settings page change, because the settings page now imports `dedupe.ts` and one more export of
`lib/qr.ts`, and `migration.ts` gains its bound. Measured on builds of the live tree (with the side panel) and of the
patched tree:

| Popup, gzipped                     | Before | After  | Budget | Headroom |
| ---------------------------------- | ------ | ------ | ------ | -------- |
| store build, gate closed: total    | 59,065 | 59,065 | 61,440 | 2,375    |
| store build, gate open: total      | 59,902 | 59,904 | 61,440 | 1,536    |

**Unit tests** (`test/unit/importfile-*.test.ts`):

- every format, encrypted detection, CRLF/BOM/UTF-16, a JSON bomb, 100,000 lines, the caps, and a 5 MiB single line;
- the review's cases as assertions: a whole-line link equal to the paste box for `'`, `,`, `;`, `|` and a raw space;
  a cut link refused; Sixkey's own export round-tripped; `&amp;`; web page exports; unreadable and nested parameters;
  a 2FAS file without `schemaVersion`; KeePassXC, LastPass, Proton Pass, Dashlane and 1Password CSVs; lone surrogates;
  the Steam spellings; `motp://`; `batch_size` of 2^31;
- every format's own parameters (2FAS, Raivo, FreeOTP+, andOTP, Aegis with SHA-256/8/60 and alike), not only defaults;
- HOTP, Steam, mOTP and Yandex; that no password column is read;
- a canary secret never in a report, as fixed cases, a property test, and a CSV case;
- the export assembly (out of order, repeats, another export, missing codes, seeding, the batch bound);
- the delete logic with fake handles (granted, denied, `remove()` failing, changed by size, time or bytes, no
  handle, no `remove`, nothing added) and what a deleted file would lose;
- `readPicked` with Node's File: the 5 MiB and 20 MiB caps, the hash, what was refused;
- the camera controller with a fake `getUserMedia` (every exit path stops every track, including a late stream);
- the plan's duplicates, the paste box's cleaning and which files are offered.

**Hand mutants.** 42 against the unit tests (revision 1's 24, with M2 replaced by a non-equivalent one, and the review's
findings and survivors), each applied alone, all killed; a comment-only control survived. 7 more against the e2e
tests, each with the e2e build rebuilt, all killed: the import not cleared at a lock; the camera left on at a lock;
files deleted right after Add without a click; the first row's handle deleted whichever row was clicked; Delete first
for a file with entries not imported; camera codes written into the paste box; the paste box editable when locked.
The last of revision 1's M1/M3 held only by source-text regexes are now killed at run time by the two-file e2e test.

**End to end** (`test/e2e/import-file.spec.ts`, plus new states in `visual-guard.spec.ts`):

- the owner-shaped file through `setInputFiles`, then the prompt without a handle (no question, the instruction);
- the same file again (all duplicates, no prompt);
- Aegis with a Steam account (its prompt says one was not imported), encrypted Aegis, and a Sixkey backup;
- Backup's handover, of an export and of a file with no accounts;
- deleting through a real private-file-system handle: granted, refused, kept, changed;
- two files with handles: both still there after Add; Delete on the second deletes the second only; the second's
  prompt (a Steam entry not imported) puts Keep it first, the first's puts Delete file first;
- a lock clearing the import and disabling the paste box;
- a failed picker falling back to the file input;
- the camera with Chromium's fake device playing a generated Y4M of QR codes (`--use-file-for-fake-video-capture`):
  one link, and a three-code export collected to the end, in the camera's own row, the paste box empty; every camera
  track ended once a code is read, and at a lock;
- the camera refused, missing or busy, by `getUserMedia` stand-ins;
- the visual guard, in both themes and languages, wide and at 420 px: files chosen with a skipped line and a Steam
  count, an encrypted file, the camera refused and live, and the prompt without and with a handle.

**A test fixed on the way** (revision 1). `export.spec.ts` "a typed master password does not wait in the field" read
the export password field just after a lock from the popup. The field goes with the rest of the unlocked page, often
before the read, so the test failed 3 times in 12 on the unpatched tree. It now waits for the unlock bar, unlocks on
the same page, and checks the field is back and empty.

**Results** of revision 2, on the live tree with the side panel merged (the e2e ran once, serially, in a copy whose API
port was moved from 8787 to 18787, because an unrelated program holds 8787):

- the whole unit suite, once: 200 files; 2,868 passed, 4 expected failures, 1 skipped, none failed (before the side
  panel landed, the same import code ran green as well: 197 files, 2,799 passed);
- `npm run e2e`: 145 of 146 passed, and check-dist passed on the e2e and dev builds. The one failure was
  `regression/offscreen-race.spec.ts` (two clipboard clean-ups 20 ms apart, in the service worker, which this patch does
  not touch); run again, it passed 6 times in 6. Before the side panel landed, the same suite passed 141 of 141;
- the 42 unit mutants and 7 e2e mutants above were run on the tree before the side panel landed; the import modules
  and their tests are byte for byte the same after it;
- the prod build with its check-dist, with the release gate closed and open: passed; typecheck, `format:check` and
  `messages.py` too.

## 8. Open points

- Whether files should skip HOTP until Sixkey makes HOTP codes (§3). As built, HOTP is imported, as the paste box does,
  and the delete prompt names it.
- The real-browser facts marked [unverified] above: the picker in an extension tab, Chrome's write prompt, a Finder
  drop's handle, and the camera prompt on the owner's machine. They are owner checks.
- A file whose bytes are an encrypted export of an app not listed is "No accounts found", not "encrypted".
- Clearing the paste box at a lock is new behaviour. Text being typed is lost when Sixkey locks.
- The same key, issuer and account with other parameters is added beside the old account, with no warning; the popup
  has the "rebind" idea for this. An account in the trash is not a duplicate, so restoring it later gives two.
- A pasted QR screenshot still goes into the paste box as its link, as before this change.
- The trash wording is "Trash or Recycle Bin" on every system.

## 9. Revision 2: the review's findings

| Finding | What changed |
| --- | --- |
| B1: a link cut at `'` `,` `;` `\|` or a space lost its parameters, silently | a line that is a link is taken whole, as the paste box takes it; a link cut where parameters follow is refused (§3) |
| M1: Sixkey's own export did not round-trip | fixed by B1's change; a round-trip test with `Lowe's`, `Macy's`, `Ben & Jerry's` and other parameters |
| M2: `&amp;` links took the defaults; HTML exports claimed to be read | `&amp;` read as `&` in files and the box; web page exports explained; the notes corrected |
| M3: unreadable or nested JSON parameters took the defaults | an unreadable one refuses the entry; one sub-object's parameters are read, others refuse; 2FAS recognised by its services |
| M4: CSVs took the website column | the key column by name or by its links, never `url`/`uri`; five password managers' shapes tested |
| M5: a quadratic regex (50 s on a 300 KiB line) | a loop; the cut check linear; a 5 MiB single-line test |
| M6: the delete prompt hid what deleting loses | it says how many entries were not imported (Keep it first) and how many came in as HOTP |
| minor 1: a lone surrogate threw | replaced before encoding; a backstop; Backup no longer reads the text at all |
| minor 2: `batch_size` unbounded | at most 1,000, in `migration.ts` (the popup's confirm page too) |
| minor 3: `%73team` dodged the Steam guard | the `encoder` parameter read as the importer reads it |
| minor 4: Backup kept andOTP `.aes`, ZIPs and UTF-16 to itself | every non-backup file goes to Add account |
| minor 5: a question with no answer | without a handle the row only says how to delete the file |
| minor 6: "Trash" only | "Trash or Recycle Bin" |
| minor 7: "Export again from OpenPGP" | "andOTP (OpenPGP)", and the app named once |
| minor 8: size and time only | the SHA-256 of the bytes as well |
| minor 9: camera codes shown in the box | a row of their own |
| minor 10: the box editable when locked | disabled while locked |
| NITs | messages without the repeated file name; the icon on the first line; "Stop camera"; the backup link is the message; zh_CN wording; `motp://` counted |
| overlap with SIDEPANEL | the checklist item is 19; the §2.2 context table of ARCHITECTURE.md is no longer touched |

## 10. Revision 3: the re-review's findings

The re-review confirmed every finding of §9 fixed, and found new problems the fixes made:

| Finding | What changed |
| --- | --- |
| N1: a word after a link joined its secret (`secret=K work` gave `KWORK`), in files and in the paste box | a `secret` value with white space followed by more text, as written, refuses the link ("secret key is not valid"), in every entry point (§3) |
| N2: links joined by `,` `;` `\|` on one line lost all but the first, and the delete prompt then offered Delete | a separator before another link starts the next link; a link after a cut-off cell is read too; nothing on the line is dropped |
| N3: the camera's codes skipped the checks (a Steam code came in as a 6-digit TOTP) | every camera code goes through `readQrTexts`, as a QR image's does; its row shows what was refused |
| N4: an unknown JSON file's sub-object timers taken as the period (`sync.interval: 300`) | parameters only from the entry or a sub-object named for them; a code-setting key anywhere else refuses the entry; an unknown file's period must be 10 to 300 s |
| N5: `&amp;amp;` took the defaults | decoded until it no longer changes, at most four times; a link still escaped is refused |
| X04, X05, X18, X02 (mutants that survived) | tests: a plain key line the importer refuses counts as not imported; a CSV link column with an unknown name; the HOTP count over what was added; a sentence's full stop |
| NIT: the Settings row of ARCHITECTURE §2.2 lost its wording in the merge | restored: "accounts (with file import and the camera)" |
| NIT: HTML exports starting with a comment or `<head>`; the prompt's plural wording | detected; "Accounts in it not imported: N", "Counter-based (HOTP) accounts from it: N" |

**One validation path.** `test/unit/importfile-entries.test.ts` runs each hostile link (Steam by `encoder`, a word run
into the key, `&amp;` escaped once and twice) through every entry point: the paste box, a text file, a QR image and
the camera (`readQrTexts`), and a link inside an unknown JSON file, and holds them to the same outcome. The e2e adds
the camera with a Steam code, two links on one line, and a run-on secret in a file and in the paste box.

**The popup is byte for byte the same** as on the live tree before this revision: every popup asset of the prod build
is identical. (A direct import of the reader from `AddAccounts.tsx` renamed a chunk the popup shares; the camera's
check goes through `import-read.ts` instead, which the page already imports.)

**Results of revision 3** (each heavy run under the shared lock; the e2e serially, with the API port moved to 18787):

- the whole unit suite, once: 201 files; 2,881 passed, 4 expected failures, 1 skipped, none failed;
- `npm run e2e`: 148 of 148 passed; check-dist passed on the prod, e2e and dev builds;
- hand mutants: 53 against the unit tests (§7's 42 and 11 for this revision's rules: N1 in a file and in the paste
  box, N2 twice, N4 twice, N5, X04, X05, X18, X02), all killed, and the comment-only control survived; 8 against the
  e2e tests (§7's 7 and the camera's codes taken unchecked), all killed. X05's test was strengthened after its mutant
  survived the first batch (the link reader takes such a file's links too; the test now asserts it is read as CSV);
- typecheck, `format:check` and `messages.py`: passed. `settings-accounts` 2,454 of 3,072 B and the settings page with
  every part 11,345 of 12,288 B (zh_CN); the popup unchanged.
