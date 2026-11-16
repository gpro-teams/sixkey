# Password setup notes: "Generate for me" first, without lowering the bar

> **Superseded in part (2026-10-22, OWNER-DECISIONS/15; [OWN-PASSWORD-NOTES.md](OWN-PASSWORD-NOTES.md)).** For the
> master password, the user's own now comes first and "Generate for me" is the secondary choice after the fields;
> below 50 bits is a warning with "Use anyway", not a block (the page's rule is `masterAccepts` in src/ui/strength.ts:
> the floor, and 50 bits or "Use anyway" for that value); new master-password wraps use PBKDF2 2,000,000 iterations.
> What follows still holds for backup files' passwords and the sync key operations (the bar and, for backup files, the
> order are unchanged), and for the generators, the registry, what the browser keeps and the tolerant prompts, which
> did not change. Where it says "the bar", "accepted" or "first" of the master password, read OWN-PASSWORD-NOTES.md.

Owner feedback: setting a master password takes too long, users may not accept 50 bits, and the generated password "does
not look like 50 bits". This change makes a generated password the first and easiest choice, and explains it, without
changing the bar. `MIN_BITS` stays 50, PBKDF2-SHA256 stays at 600k or more, and the service's floor
(`checkPasswordPolicy`) is not touched.

## 1. What the user sees (`PasswordFields`, src/options/shared.tsx)

Every place that sets a new password uses this one component: first run, turning on and changing the master password,
the password reset, both backup-file passwords, and the sync key operations (behind the release gate).

- The first element is the primary button **Generate for me** (`#<prefix>-gen`). One click fills both fields and shows
  the password as page text in a green box (`#<prefix>-made`, the value in `#<prefix>-value`). The fields stay masked.
  The box also says why it is enough ("16 random characters: about 79
  bits, well above the 50 bits needed"), where to keep it, and offers **Copy** and **Easier to type: words**. The advice
  is "Save it in your password manager or write it on paper"; for a backup file it adds "the file cannot be opened
  without it". Nothing offers to save a password as a file (owner decision, revision 2): a plaintext password in
  Downloads, perhaps next to the backup file it opens, would undo the protection. The recovery key's own download is
  unchanged.
- **What the browser keeps (revision 3, review B1).** Chrome saves the state of form fields for session restore, in
  plain text, in the profile's `Default/Sessions/Session_*` and `Tabs_*` files. It skips `type="password"` fields and
  fields with `autocomplete="off"`. The review measured a revealed (text) field holding the password ending up there, on
  navigation and on browser close. So the fields stay `type="password"` unless the user ticks **Show**. While shown,
  they are `autocomplete="off"`, plus `autocapitalize="off"` and `spellcheck=false`. A generated password is shown only
  as page text, which is not form state, as the recovery key already is. The reviewer's probe (`disk-probe.mjs`, 11
  variants) finds nothing on disk with this build, and two e2e tests scan the profile after the browser closes.
- **What the page keeps (revision 3, review M1).** A generated password is remembered, in the field and in the
  strength.ts registry, only while the field holds it unchanged. It is forgotten when replaced, edited, emptied (the
  step done) or unmounted. On a lock from any page (the lock epoch) and on `pagehide`, the field also empties itself, so
  a backup file's password is not left on the locked page. The registry keeps at most 4 entries as a backstop, the most
  fields a page shows at once. `forgetGenerated()` can only send strings back to zxcvbn.
- **Copy** writes to the clipboard and arms the extension's existing clean-up, `armClipboardClear` (platform/clipboard.ts).
  This is the same one the sync section uses for its recovery key: after 30 s, only if the clipboard still holds this
  password (checked by a hash), and only when the user has granted the optional clipboard permissions. The settings
  page's recovery-code Copy, which predates this, does not clear. "Copied" is announced in a `role="status"` region.
- **Races (review m1, m3).** A generation still under way, such as the word list loading, is dropped when the user
  types, chooses their own, a lock comes or the page goes away (a run counter). The parent's strength is set to `null` in
  a layout effect, in the same task as the edit. Security (turning the password on, changing it), Backup (both exports)
  and the sync key operations now check `measure()` once more before writing, as first run and reset already did.
- **Choose my own** (`#<prefix>-own`) sits next to it. The fields are always visible, so typing or pasting works as
  before, and nothing intercepts paste. After a generated password, Choose my own empties both fields and puts the
  cursor in the first one.
- When a typed password is below the bar, the line says by how much ("Estimated 34 of 50 bits: 16 bits short. ...") and
  shows **Use a generated password instead** next to it. A long password that the floor refuses (a keyboard run or
  repeats) gets its own message instead of a nonsensical "0 short".
- The meter lights all ten bars exactly when the password is accepted. Below the bar it lights at most nine.
- Accessibility: the strength line has `aria-live="polite"`. The input's `aria-describedby` points to it, and to the
  explanation while that is shown. Choose my own moves focus to the input. After "Use a generated password instead",
  which removes itself, focus goes to Copy. The generator buttons say `aria-disabled` while busy instead of `disabled`, so
  they keep the focus. Colours come from the existing tokens, so
  dark and light themes both work.

## 2. Generated passwords are counted honestly (src/ui/strength.ts)

zxcvbn misjudges random output in both directions. Measured over 400 samples each:

| Style                         | Real entropy | zxcvbn says                               |
| ----------------------------- | ------------ | ----------------------------------------- |
| 16 characters from 31         | 79.3 bits    | about 63 bits (59 to 63)                  |
| 5 words from 7,776            | 64.6 bits    | 76 to 97 (median 88)                      |
| `abacus-abacus-able-acid-...` | -            | 50.2: low-rank words pull it near the bar |

For this reason `measure()` keeps a small private registry of the exact strings the two generators produced on this
page and that a field still shows (§1; at most 4). For an exact match it reports the generator's known entropy and marks the result
`generated: true`. Everything else, including any edit of a generated string, goes to zxcvbn as before. Acceptance is a
single expression on both paths: `floorOk && bits >= MIN_BITS`. Only the generators write to the registry, so no caller
can pass in a bit count.

The meter, the button and the last check before writing go through the same function. The line shows an answer only
for the value it was measured for. The parent gets `null` in the same task as an edit (a layout effect), and every page
checks again before writing (§1). A generated password pasted back after "Choose my own" has been forgotten, so it is
estimated, and the line and the button agree on it (review m2).

## 3. The generators

- `uniformIndex(n)`: draws 32 bits from `crypto.getRandomValues` and rejects any value at or above
  `2^32 - (2^32 mod n)`. This removes modulo bias. The old code used `byte % 31`, which made the first 8 symbols 9/8 as
  likely as the others.
- `suggestPassword()`: still 16 symbols from the same 31-symbol alphabet (no I, L, O, 0, 1), in four groups of four.
  With uniform draws that is exactly 16 × log2 31 = 79.27 bits. Removing the bias raises the entropy, so a 17th symbol is
  not needed, and 16 keeps the 4×4 grouping.
- `suggestPassphrase()`: 5 words joined by `-`, giving 5 × log2 7776 = 64.6 bits. The word list is the EFF large wordlist
  that `@zxcvbn-ts/language-common` already ships as its `diceware-common` dictionary. It is loaded through the same lazy
  import `measure()` uses, so the change adds no bytes, no dependency and no network fetch. Before use the list is
  checked: all entries distinct, `a-z` only so the separator stays unambiguous, and large enough that 5 words reach
  `MIN_BITS`. If any check fails, no passphrase is made.
- The word list is the EFF list as packaged by zxcvbn-ts: its four hyphenated words appear joined (`tshirt`, `yoyo`,
  `dropdown`, `felttip`). The notice says so. The entropy is unaffected.
- Every loop is bounded (`MAX_DRAWS` = 1000). A broken random source, such as all zeros or a constant, throws instead
  of hanging the page.
- Both generators draw again if an output would fail the service's floor (for example `acid-acid-acid-acid-acid`, which
  has only five distinct characters). Such outputs are a negligible share of the space, so the entropy figures hold to
  many decimal places.

## 4. Text and size

The new text is 10 keys in the full catalog (scripts/i18n/pwsetup.py). It also overrides two existing keys:
`strengthLow`, which now shows the missing bits, and `generate`, now "Generate for me" / "帮我生成", so that
`errNextWeak` ("... or use “Generate for me”") still names the button.

Measured on a prod build, with gzip at the same default level check-dist uses:

| Catalog                   | Before   | After    | Limit    |
| ------------------------- | -------- | -------- | -------- |
| zh_CN full                | 11,923 B | 12,150 B | 12,288 B |
| en full                   | 10,539 B | 10,760 B | 12,288 B |
| popup catalog (zh_CN)     | 4,162 B  | 4,166 B  | -        |
| popup total (static + zh) | 59,575 B | 59,623 B | 61,440 B |

The popup total stays 58.2 KB of its 60 KB budget. None of these screens is in the popup graph. The popup gains the new
text of `generate`, which it already carried, and 42 B from revision 3. The settings page now also imports
platform/clipboard.ts, so the bundler moves that module out of the popup's entry chunk into the chunk the two pages
share. Importing it lazily was measured as worse: 60,052 B.

**Headroom is now 138 B (about 1%).** The next text added to the full catalog, by any package, will reach the limit.
A split was built and measured, then left out because the text fits. In revisions 2 and 3 it was not added either; revision
3 adds no text. The split touches
scripts/messages.py, scripts/build.mjs, scripts/check-dist.mjs (with tamper tests for its new rules) and the page's entry,
which is not a small change. It is:

- a third catalog, `catalogs/password-<lang>.json`, from `PW_EN`/`PW_ZH` fragment tables, with keys disjoint from the
  other catalogs;
- its own chunk, `assets/password-locale-<lang>-*.js`, with its own check-dist limit (about 0.6 KB in zh_CN);
- loaded together with the full catalog, because almost every settings page shows a password field.

With that split, the full zh_CN catalog would drop to 11,796 B. This is the ready proposal if the owner prefers the
split to raising `FULL_CATALOG_GZ`. The limit was not raised.

## 5. Tests

- test/unit/password-setup.test.ts:
  - the floor is pinned (`MIN_BITS` 50, 16 characters, 5 words, both above the bar);
  - rejection sampling, with scripted draws: `2^32 - 1` and the limit itself are rejected;
  - chi-square flatness, over seeded draws so the test cannot flake: 31 symbols overall and per position, and the
    7,776-word index;
  - alphabet, format and floor for 2,000 passwords and 300 phrases;
  - a floor-failing draw is drawn again;
  - word-list checks;
  - the registry matches the exact string only;
  - zxcvbn clears the bar on strings of the character shape;
  - meterView as a table, plus a property: full bar if and only if accepted, and a shortfall is never 0;
  - source rules: every caller, `purpose="file"` only on backups, the generator before the input as the primary
    button, no paste or copy interception, no bit-count prop, the registry written only by the generators, `%` only in
    `uniformIndex`, `aria-live`, and the re-checks unchanged.
- Hand-made mutants, applied one at a time, all killed (17 in revision 1, an 18th in revision 2):
  - no rejection; `<=` instead of `<`; the old byte modulo; 3 words; `MIN_BITS` 40;
  - acceptance without the floor; the registry matching a prefix, or case or white-space variants; the registry
    ignored;
  - no redraw on floor failure;
  - the view: ignoring known bits, a full bar below the bar, a rounded shortfall;
  - a passphrase bit claim not derived from the list; each of the three word-list checks removed.
- test/e2e/password-setup.spec.ts:
  - first run: order and primary button, generate, explanation and advice, Copy (clipboard) and no file-saving
    control, words, edit falls back, Choose my own, the shortfall message with one click to a generated password, paste not
    prevented, then finishing with a generated password, restarting and unlocking with it;
  - settings: turning the password on with a generated one, changing it to a passphrase, and a backup file whose
    generated password opens it (no file-saving control there either).
- Revision 2 adds a source rule (no `download(`, `saveAsFile`, download icon, Blob or object URL in the component; the
  advice never names a file, a download or the recovery key) with its mutant, putting the Save-as-file button back, killed;
  and a check that the EFF notice names the passphrase generator.
- Revision 3 adds:
  - the review's unit probes as permanent tests: the randomness source; each draw gives `list[k]` across the whole list,
    which kills the 4,096-word and last-word mutants; the rejection bound for awkward ranges; the registry (measure
    never adds, full-width variants, `forgetGenerated`, at most 4); bounded draws;
  - source rules for every fix;
  - the review's e2e probes as tests: nothing on disk (generated, and typed with Show), pasted back, focus, Choose my own
    winning over a late passphrase, the button never enabled on an earlier answer, a lock emptying a backup password.
  - 19 more mutants, one per fix, all killed. The 17 earlier mutants still die against the new code.
- e2e run (revision 3): in a scratch copy with the port moved to 18787, the affected specs (password-setup, firstrun,
  flows, export, export-selection, reset) ran once: 54 out of 54 passed. The reviewer's standalone probes ran against
  this prod build. `disk-probe.mjs` found nothing on disk in any of its 11 variants. `ui-probe.mjs` and `lock-probe.mjs`
  showed every case fixed.
- e2e run (revision 1): in a scratch copy with the API port moved from 8787 to 18787, because 8787 was held by an unrelated program.
  The specs run were password-setup, firstrun, flows, export, export-selection and reset, 47 tests. All pass except
  `export.spec.ts:344` ("emptied ... on a lock"). That is an existing race between the field being emptied and the page
  re-rendering as locked, and it fails about 1 run in 8 on the unpatched build as well. `test/sync/m6-section.spec.ts`
  (the sync key operations, which also use these fields) needs the live server and was not run.

## 6. Decided and open

1. **Save as file: removed** (owner, revision 2) for master and backup-file passwords. Copy stays; the recovery key's
   download is untouched.
2. **Advice: decided** (owner, revision 2): "Save it in your password manager or write it on paper", without "keep it
   with the recovery key"; backup files add "the file cannot be opened without it".
3. **Catalog headroom: open.** 138 B left after §4, 55 B after §8 (§8.4). Take the ready split when the next text
   arrives, or raise `FULL_CATALOG_GZ` explicitly.
4. **The word list's licence: done.** The EFF list is CC BY 3.0 US and is already shipped inside zxcvbn-ts
   (OWNER-DECISIONS/05: "keep, with full notices"). Its entry in `extension/scripts/notices-data.mjs`
   (`@zxcvbn-ts/language-common` › `src/diceware.json`) now also names the passphrase generator, and
   THIRD-PARTY-NOTICES.md is regenerated (`npm run notices`). If zxcvbn is ever dropped, the passphrase style goes with
   it, unless the list is kept separately with its notice.
5. **"Recovery key": decided** (owner, revision 2). New copy keeps "recovery code" (earlier name) so that one flow does not use two
   names; with the reworded advice, no new string names it at all. No storage key is involved. (Renamed "recovery key" /
   "恢复密钥" everywhere on 2026-10-23, OWNER-DECISIONS/16 question C.)

## 7. Typing a generated password back: hyphens and capitals optional

Owner feedback after §1–§6: a generated password is shown as `JDXT-NBSG-6JQG-XBTV`, and every prompt made the user type
the hyphens and the exact case. The stored password stays exactly what the generator made. The prompts now also accept
it typed loosely. Nothing is re-encrypted, existing vaults work unchanged, and no set or change path stores anything but
the exact string it was given. Revision 2 follows an independent review (its report is kept outside the repository; its
findings are cited by their names): B1 (§7.4), M1's design (§7.5), M2 (the inventories in PRIVACY.md, ARCHITECTURE.md §3
and security/local-vault.md), M3 (§8.1: the hint is never on disk) and the minor points m1–m6. Revision 3 is the same
change on the tree with enrolment-v2, with turning sync on tolerant again at every step (§7.2).

### 7.1 What is accepted (src/core/crypto/password-candidates.ts)

`passwordCandidates(typed)` is pure and has no imports (the popup carries it). It returns `typed` first, exactly as
given, and at most one more string: the generator's own spelling of `typed`, when `typed` has one of the two generated
shapes and is not already that spelling. After NFKC, as the key derivation normalises:

- **5 words** (`gen5words-v1`): exactly 5 words of 3 to 9 ASCII letters, separated by runs of spaces, tabs, `_` or `-`.
  The spelling is lower case joined by `-`. No word list is used (the popup has none; a test checks that every one of
  the list's 7,776 words fits the word rule).
- **16 symbols** (`gen16-v1`): once spaces and `-` are removed, exactly 16 symbols of the generator's 31 (`CHARS`, a
  test holds the two equal), in either case. The spelling is `AAAA-BBBB-CCCC-DDDD` in capitals.
- When both fit (five short words without I, L or O, 16 letters in all), the words win. A 16-symbol spelling has 4
  groups, so it is never 5 words, and this way every spelling of either kind is its own (tested both ways).
- Anything else gets no second string: a wrong length, a symbol the generator never makes (I, L, O, 0, 1, `!`), another
  separator, 4 or 6 words, digits in a word, non-ASCII letters.

A password of the user's own that merely has a shape (`supersecretpassw`: 16 letters, none of them I, L or O) is tried
as typed first, and only then as `SUPE-RSEC-RETP-ASSW`. It opens only as itself, because the vault opens for one stored
string. No loose spelling of a non-generated password is ever tried.

### 7.2 Where: one check for every local prompt

`openWithPassword(keyring, typed)` (src/core/crypto/keyring.ts) is the one check. It derives a key for the first
candidate and, only if that key fails to unwrap, for the second. It returns the vault key and **the spelling that opened
it**. Only a wrong key moves on to the second try: an empty password, a missing wrap or bad parameters throw at once.
Every local check of the master password goes through it:

- the lock screen and the settings unlock bar (`unlockWithPassword`);
- the prompts that ask again (`verifyPassword`, so `requireMasterPassword`): an export, clearing the security log, a
  new recovery key, a permanent delete, and the sync section's "discard kept vaults";
- a key rotation and a password change (`unlockWith2`), and the PIN box (`PinAdmin`: set and remove);
- turning sync on, at each of its three steps, so that they agree: step 2 (`verifyPassword`), step 4 (b)
  (`prepareUploadRecovery`) and the first upload (`firstUpload`, revision 3). The first upload resolves the spelling
  against the local keyring, which it publishes, and derives the server's verifier from that spelling (§7.5 item 6).

A backup file's password goes through the same candidates in `openBackup` (first run's restore and Settings › Backup).
The file format has no room for a hint and gets none.

Whatever is derived from the password after the check uses the spelling that opened the keyring, never the typed one.
That spelling is the stored password, so a key rotation re-wraps the same password, and the first upload's server
verifier is the stored password's. Tests check both: after a loosely typed rotation, the exact check
(`unlockWithPassword`) opens with the exact spelling and refuses the loose one; after a loosely typed first upload, the
server takes the exact password. Had the typed string been used, the stored password would have become the loose
spelling.

### 7.3 What it costs

- **Entropy: unchanged.** An attacker still has to find the stored string among all 31^16 (79.3 bits) or 7,776^5
  (64.6 bits). Accepting more inputs multiplies the strings that open the vault, not the secrets that do. Each typed
  string has at most one other candidate, which is a function of what was typed.
- **Offline, with a copy of the profile: no change.** That attacker runs PBKDF2 on candidate secrets directly. The
  prompt's tolerance plays no part.
- **Online, at a prompt: no change per secret.** One attempt tests at most two secrets, and costs two key derivations.
  The rate of secrets tested per second of PBKDF2 is the same as before. There is no lockout (F23), so the only visible
  difference is that one entry in the security record can stand for two tested secrets (local-vault.md says so).
- **Time, honestly.** A loosely typed correct password costs two derivations (as typed, then the spelling), so that
  unlock takes about twice as long. A wrong input with a generated shape also costs two. Every other input, right or
  wrong, costs one, as before, and so does the exact spelling. One derivation (PBKDF2-SHA256, 600,000 iterations)
  measured 59 ms in Node on the development machine (`scripts/bench-kdf.mjs`). A wrap made since 2026-10-22 has
  2,000,000 iterations: 157 ms in Chrome on that machine, so about 0.3 s for an attempt that costs two
  (OWN-PASSWORD-NOTES.md §2). Slower machines and the browser take
  more. The difference shows only that the typed string had a generated shape, which the person typing knows.
- **One attempt is one failure.** A wrong password at any prompt is one `unlock_failed` entry in the security log and
  one count in its `failed` counter, never two. The PIN's tries and its set-up are not touched by a master-password
  attempt. An empty password is still a typo: not recorded, and not tried twice.
- **Nothing stored** for the tolerance itself.

### 7.4 The subset export's file password (review B1)

Settings › Backup's "selected accounts" file goes to someone else, so its password must not be the master password. The
guard compared NFKC forms only, so `jdxt nbsg 6jqg xbtv` passed it for a master password of `JDXT-NBSG-6JQG-XBTV`,
although that string opens the vault at every prompt. It now compares what the prompts compare (`sameMasterPassword`,
Backup.tsx): the generator's spelling where there is one, NFKC otherwise. If the master password typed above it opens
the vault, every string that opens the vault compares equal to it (spellings are fixed points, and depend on NFKC
only), so each is refused (password-entry-samepw.test.ts checks this against the real `openWithPassword`). It is a pure
comparison: no call asks the service whether a string opens the vault, which would be a password oracle the security
record never sees.

### 7.5 Not covered yet: the sync engine's checks, and the resolver they need (review M1)

The sync engine still checks the password exactly (`unlockWithPassword` and `openKeyring`), at:

- the 12 `preSend(e, c, op, { password })` sites in keys.ts (change password, new recovery key, rotation, repair,
  revoke and its check, fork, delete the account, rename, reject all, clear history, turn sync off), and repair's
  second password;
- the approver (`preSendCheck({ secret: { password } })` in enroll.ts, about line 743 since enrolment-v2): it opens the
  server's bundle, which only the resolver's second step covers;
- the join's and adoption's `openKeyring` on a server bundle.

(Turning sync on is covered since revision 3, §7.2: its steps check the local keyring only, so they need no resolver.)

A loose spelling is refused there before anything is sent: `preSendCheck` opens the MAC-verified server bundle locally
before it derives a proof, and the review's probe P6 (password-entry-review.test.ts, kept) taps the fake server: no
`password_auth` for a wrong or loose spelling, exactly one, accepted, for the exact one. So this is inconsistent, not
unsafe. It blocks opening the release gate, not this change. The design to build then:

1. **One resolver**, `resolvePassword(local, server?, typed): ResolvedPassword`. It returns the spelling that opens the
   **local** keyring (`openWithPassword`). Failing that, the spelling that opens the MAC-verified **server** keyring
   that `GET /v1/keys` just returned (still on the device, before any proof exists). Failing both, `typed` unchanged:
   today's behaviour, for a password changed on another device that the local keyring does not know.
2. **A branded type.** `ResolvedPassword` is a branded string. `preSendCheck`'s secret, `passwordProof`, every new wrap
   (`rekey`, `setPassword`), `commitPublished` and `published()` take only that type. Each operation's raw parameter is
   renamed `typed`, so nothing after the resolver can use it: a silent change of spelling fails to compile instead of
   waiting for a test.
3. **Never re-wrap under the loose spelling.** The hazard of a naive fix: a rotation or password change that resolves
   the spelling for its proof but builds the new wrap from the typed string makes the loose spelling the stored
   password, and the canonical one the user saved stops working at every prompt (spellings go loose → canonical only).
   `published()`'s lock-out guard would not catch it: it is handed the same typed secret, and runs after the server
   accepted. Resolution must not happen inside `preSend` either, for the same reason: it must happen once, at the entry
   of each operation, and everything after uses its result.
4. **A new password stays exact.** Resolve only the current or old one; the new one of a change, a reset or a repair,
   and `reconcile.ts`'s `newPassword`, are stored as given.
5. **One request, one proof.** No retry loop may send a second `password_auth`; the server never sees a candidate the
   device has not verified (P6 stays).
6. **Turning sync on: done** (revision 3). Step 4 (b) and the first upload each resolve the spelling against the local
   keyring (`openWithPassword`), and the first upload's server verifier is the stored spelling's. With the branded type,
   `passwordProof` there takes the `ResolvedPassword` the first upload already has.
7. **Tests,** for each operation: the loose spelling succeeds with exactly one accepted proof; afterwards the exact
   `unlockWithPassword(keyring, GEN)` opens the keyring; mutants that wrap or derive a proof from `typed` are killed.
   password-entry-service.test.ts's "the sync engine's own checks stay exact" is then replaced.
8. **Enrolment-v2 has landed**, so the approver's site is the one at about line 743. Measure whether any of the
   resolver reaches the popup's shared chunk with the gate open.

## 8. The input hint and the grouped input

### 8.1 The hint: `sk_pw_format` (src/core/service/pw-format.ts), in session storage only

`{ v: 1, format: "gen16-v1" | "gen5words-v1", salt }`. `salt` is the KDF salt of the keyring's password wrap it was
written beside. Every new password gets a new salt, so a record for an earlier password simply stops applying, for
example after a change in another page or a password adopted from another device.

- **Where: `chrome.storage.session` only** (memory; Sixkey's own pages and service worker), never `chrome.storage.local`
  (owner decision on review M3). With no session area, the runtime builds no hint store at all: it never falls back
  to the storage helper's default, which is `chrome.storage.local` (a source rule). On disk, its presence or absence would tell someone with a copy of the profile which
  master passwords are a user's own. Worse, for a user's own lower-case 5-word passphrase (a common style) it would
  publish the exact structure, which turns the search into a dictionary attack. So nothing of it is ever persisted. It
  has a key of its own: no lock removes it (a lock clears `sk_session`, a hard lock `sk_quick`), so the unlock bar keeps
  the grouped input across locks. It goes when the browser closes or the extension reloads.
- **Written** only by the service, and only after the change has committed: when a vault is made (first run, restore,
  start over), when the master password is turned on, changed, reset or re-wrapped by a rotation. It is written only
  when the new password is exactly a generator spelling (`formatRecord`). Otherwise the record is removed.
- **Learnt again after a restart (no re-encryption).** After a successful password unlock, the record is made to agree
  with the spelling that opened the keyring: one read of `chrome.storage.session`, and a write only when it does not
  agree (written for a generator spelling, removed when a forged or stale one says otherwise). The steady state writes
  nothing. So after a browser restart the prompts show the plain field, which takes a generated password typed loosely
  all the same, until the first password unlock, usually the popup's.
- **Reads.** Nothing of it is ever read from `chrome.storage.local`: the local read gates are exactly as before this
  change (read-budget, quick-read-budget and perf.spec pass unchanged). The popup's lock screen gets it with its view
  since revision 4 (§8.3): one `chrome.storage.session` get beside `sk_quick`'s, checked against the keyring that open
  has already read. The unlock adds one `chrome.storage.session` get, after the vault is open. The settings page reads
  it with one load and one session get (`platform/runtime.ts passwordFormat`).
- **Migration.** None is needed: no released version wrote the record. A vault from before it learns the hint at the
  first password unlock of each browser session.
- **Not in the keyring.** The keyring is copied to every slot, snapshot and the mirror, compared byte for byte (a reset,
  a first run's retry), and synced inside a MACed key bundle; learning the hint at an unlock would be a keyring write,
  which sync would see as a key change. And the keyring is on disk.
- **Never trusted.** The candidates take only the typed string, never the hint, and no check reads it (source rules).
  A wrong or forged hint changes which field is shown and nothing else, at no extra cost: a forged "16 symbols" hint for
  a user's own password does not make its "spelling" open it, and adds no key derivation for a wrong password of
  another shape. The next unlock removes it. The grouped field always offers **Use a plain password field**.
- **What it tells, and to whom:** nothing to a copy of the profile (it is not on disk). Code running in Sixkey's own
  pages could read it, and could read far more there. It holds no part of the password.

### 8.2 The settings page's prompts (src/options/MasterField.tsx, src/ui/PasswordGroups.tsx)

Every place on the settings page that asks for the master password renders `MasterField`, which picks the field from the
hint:

- the unlock bar, the change of password's old password, a new recovery key, a key rotation, the PIN box, the
  permanent delete, clearing the security log, and the export's confirmation.
- The sync section's prompts are not changed (that package's files): plain fields.

`MasterField` reads the hint itself, through one reader for the page (`hintReader`): the fields of one render read
once; the record changing in any page (`chrome.storage.session` onChanged) reads again; and reads are numbered, so an
answer that comes back late never replaces a newer one (review m2). The field shown follows the hint **only while
nothing is typed**: a hint learnt by an unlock in another page never swaps the input under the user's fingers (review
m1). This keeps the settings page's `App` and `Ctx` as they were.

**For 16 symbols:** four boxes of four, with the hyphens drawn between them, never typed. The boxes are one string of at
most 16 symbols shown in four parts, like a field that formats itself.

- What goes in is read as the plain field's check reads a code, with the same helper (`compactCode`,
  password-candidates.ts): NFKC, white space and `-` taken out, letters as capitals. Since revision 4's review
  (POPSEG, NIT-3) the boxes take and refuse exactly what that check does. Anything else (I, L, O, 0, 1, a lookalike
  dash such as U+2010, U+2013 or U+2212, a zero-width character) is refused, and so is a 17th symbol: a key does
  nothing, a paste goes in not at all. Before, the boxes dropped such characters and kept the first 16 symbols of a
  longer paste, so a code with typographic dashes, or `Password: CODE`, opened in the boxes but not in the plain field.
  A test checks the two readings agree on 3,000 random strings.
- A box that fills moves the caret on to the next one, as one-time-code fields do (the move follows the user's own
  typing, WCAG 3.2.2). Backspace at the start of a box deletes the symbol before it. Since revision 4 the left and
  right arrows at a box's edge go on into the box beside, as in one field: left to before the last symbol of the box
  before, right from the end of a full box to after the first symbol of the next (the end of one box and the start of
  the next are one place, so no press is spent on it; POPSEG NIT-2). Inside a box, or with a modifier, the arrows are
  the browser's.
- A part pasted goes in where the caret is. A whole code pasted (its 16 symbols, with or without hyphens or spaces,
  in either case) replaces what the boxes held, whichever box it lands in. The paste handler reads the clipboard text
  itself and always inserts it itself, so a code pasted into a box that already holds some is not shifted. A password
  manager that fills the first box fills all four. Under a forged or stale hint, a password of the user's own pasted
  here is refused unless it is 16 symbols of the alphabet; the plain field is one click away.
- While an input method composes (Pinyin, for example), the boxes are left alone: an `input` event with `isComposing`
  edits nothing, and a key pressed during it is the input method's. What it commits is taken as an edit at
  `compositionend`, which Preact is given in lower case (`oncompositionend`), because Chrome has no such property and
  Preact would otherwise listen for "CompositionEnd". Before revision 4's review (POPSEG, MINOR-2), every composition
  step was rewritten into the boxes, so "jdx" came out as `JJDJDX` with Show on.
- The value is the groups joined by `-`, so a complete one is the generator's spelling. It goes to the same service
  call, which would take it loosely anyway.

**For 5 words:** the plain field, with "Type the 5 words; spaces or hyphens both work." linked by `aria-describedby`.

**Otherwise:** the plain field, as before.

**What the browser keeps.** The boxes are `type="password"` unless the eye button (Show, `aria-pressed`) is on, and
`autocomplete="off"` always. Chrome's session-restore state skips both (§1). `autocapitalize` and `spellcheck` are off.
A page can leave Show out (`showable={false}`); the popup does (§8.3). Show goes off whenever the value is emptied. The
value lives only in the page's state, and is emptied on `pagehide` and on a lock from any page (the lock epoch). An e2e
test types into the boxes with Show on, leaves the page, closes the browser, and finds no box value (UTF-16) and no
whole password (UTF-8 or UTF-16) anywhere in the profile. Chrome turns input methods off in password fields, which the
boxes are unless shown; with Show on, they compose as above.

**Accessibility.** The four boxes are one `role="group"` named by the page's visible label (`aria-labelledby`). Each box
is named "Master password, group 1 of 4" (`pwGroup`). The eye button is labelled "Show", says `aria-pressed` and
`aria-controls` the four boxes. The plain-field button moves the focus into the plain field.

### 8.3 The popup's lock screen: the grouped input too (revision 4)

Revisions 1 to 3 kept the popup's plain field, for the popup's budget alone (the measurements are below). After the
budget relief (BUDGET-NOTES.md) the owner asked for the same input as the unlock bar. The popup's lock screen now shows
the grouped input when the hint says 16 symbols.

- **The hint comes with the view.** `ServiceCore.openView`, when locked, reads the record beside `sk_quick`: one
  `chrome.storage.session` get each, side by side. It checks the record with `formatFor` against the keyring that open
  has just loaded, so the record of an earlier password says nothing here either. The view carries `format` only when
  the record applies. Nothing more is read from `chrome.storage.local`: the lock screen reads exactly `sk_session`,
  `sk_quick` and the hint from the session area, and makes 3 local gets (a test checks both lists). A read or a check
  that fails means no hint, so the plain field shows, never an error screen. An open that finds a live session reads nothing of the record. The popup's own
  code never touches the record (source rules).
- **What it shows.** In master-password mode, for `gen16-v1`, the screen shows `PasswordGroups`. The component moved to
  src/ui/ and the settings page shares it, so the popup's graph still holds nothing from src/options/. The popup draws
  it with `showable={false}`: no Show button, every box always masked. The master password is never shown on the lock
  screen, in the plain field or in the boxes (the rule in Locked.tsx and ENROLL-V2-NOTES.md §1.4). This is the owner's
  decision on the review (POPSEG MINOR-1, option b); revision 4 as first written had the settings page's Show there too.
  The first box is `#secret` and takes the focus. The screen's visible label names the group, and every box gets `aria-invalid` after a
  wrong try. Under the boxes is **Use a plain password field** (`#secret-plain`). It empties the value, clears the
  error and moves the focus into the plain field. Otherwise, and for 5 words, the screen shows the plain field as
  before, with the same tolerance. The PIN field, the recovery key's field and its Show box are unchanged.
- **Never trusted.** The hint picks the input and nothing else. The form sends its value to the same
  `unlockWithPassword`, which takes the code typed loosely in either field. A wrong or forged hint costs one click.
  The tests forge a 16-symbol hint over 5 words and a words hint over 16 symbols; both still unlock, and the unlock puts
  the record right. A missing hint shows the plain field, for example after a browser restart until the first password
  unlock.
- **What the browser keeps** is the same as on the settings page (§8.2), without Show.

| Popup, gzipped (static + largest catalog) | Before r4 | Revision 4 | Budget   | Headroom after |
| ----------------------------------------- | --------- | ---------- | -------- | -------------- |
| Store build (shipped)                     | 57,461 B  | 58,935 B   | 61,440 B | 2,505 B       |
| Store build, release gate open            | 58,324 B  | 59,778 B   | 61,440 B | 1,662 B       |

Measured on the tree with AUTOFILL-PRE's revision 2 (its "before"). The grouped input costs the popup about 1,460 B:
about 1,290 B as first written, and about 170 B more for the review's fixes (the shared reading of a paste, the
input-method guard, `showable`). Most of that is the component itself, now in the chunk both pages
share (the settings page had it in its own chunk). The rest is the lock screen's code and CSS, and two keys in the
popup's catalog (`pwGroup`, `pwPlainField`; no new text). No limit was raised. The bundler now names the shared chunk
after this module (`assets/PasswordGroups-*.js` and `.css`, formerly `errors-*`).

Before the budget relief, revisions 1 to 3 were measured on the tree before enrolment-v2 (revisions 1 and 2) and on the
tree with it (revision 3, its own "before"):

| Popup, gzipped (static + largest catalog) | Before r1–r2 | Revision 1 | Revision 2 | Before r3 | Revision 3 | Budget   |
| ----------------------------------------- | ------------ | ---------- | ---------- | --------- | ---------- | -------- |
| Store build (shipped)                     | 59,623 B     | 60,272 B   | 60,302 B   | 59,717 B  | 60,394 B   | 61,440 B |
| Store build, release gate open            | 60,492 B     | 61,127 B   | 61,171 B   | 60,604 B  | 61,287 B   | 61,440 B |

Then, with the gate open, 153 B were left. The grouped input, measured in revision 1, cost about 900 B more, which was
over the budget.

### 8.4 Text and size

Three keys in a new fragment, scripts/i18n/pwentry.py: `pwGroup` ("$1, group $2 of $3"), `pwPlainField` and
`pwWordsHint`. The settings page only, until revision 4. Revisions 2 and 4 add no text. Since revision 4 the popup's
catalogs also carry `pwGroup` and `pwPlainField`, which the build takes from the popup's code: 35 B more in
English and 45 B more in zh_CN.

| Catalog, gzipped    | Before   | After    | Limit    |
| ------------------- | -------- | -------- | -------- |
| zh_CN full          | 12,150 B | 12,233 B | 12,288 B |
| en full             | 10,760 B | 10,826 B | 12,288 B |
| popup catalog zh_CN | 4,166 B  | 4,166 B  | -        |

**Headroom in the full catalogs is now 55 B.** The next string will not fit. §4's split (a password catalog, with
pwsetup.py and pwentry.py as its first tenants) or a raised `FULL_CATALOG_GZ` is due with the next text.

### 8.5 Tests

- test/unit/password-entry.test.ts:
  - the candidates as a table: every loose spelling of each style, every near miss, and users' own passwords;
  - a property over 3,000 strings: typed first and unchanged, at most one more, and that one a fixed point;
  - the alphabet against `CHARS` and over the whole BMP, and the word rule against all 7,776 words;
  - the module's purity;
  - `openWithPassword`, counting derivations: as typed first, 1 for the exact spelling or a user's own, 2 for a loose
    one, 2 for a wrong generated shape, 1 for any other wrong one;
  - a backup file opened loosely, the same counts, and no hint in the file;
  - the grouped input's editing steps (typing, the caret, paste of a whole code or a part, an autofill, edits inside a
    box, Backspace across boxes), and source rules for what the browser keeps and for the group's names;
  - the settings page's hint reader: one read per render, out-of-order answers (only the newest applies), a failed read.
- test/unit/password-entry-service.test.ts (the real runtime over counting storage):
  - every prompt takes the loose spellings, and a wrong one at each is one record, one count and two derivations;
  - the PIN's tries are unchanged after a wrong password;
  - the rotation keeps the exact spelling; turning sync on takes the loose spelling at all three steps, with the server's
    verifier the stored spelling's; the engine's key operations stay exact (§7.5);
  - the hint: in `chrome.storage.session` only, never in `chrome.storage.local`; written for both styles and never for a
    user's own; following a change, a rotation, a reset and a removal; surviving a soft and a hard lock, gone after a
    restart and learnt again by the first unlock, then silent; not read at the lock screen, one session read at an
    unlock, none of `chrome.storage.local`; ignored for another wrap or in `chrome.storage.local`; forged with no effect
    but the field;
  - source rules: the key is spelled once, its store is built over the session area only, it is written only by the
    service, no check reads it, and every settings prompt is a `MasterField` that switches only while empty.
- test/unit/password-entry-samepw.test.ts (the review's, B1): every spelling the prompts accept is the same password,
  against the real check and as a property; different passwords stay different; the page uses the comparison.
- test/unit/password-entry-review.test.ts (the review's probes P1–P6, adapted to revision 2): only a wrong key moves on;
  the record's version is checked; a backup file's own shaped password costs one derivation; the subset guard (B1);
  step 4 (b) is one record per attempt and takes the loose spelling; the server never sees a proof the device has not
  verified.
- test/e2e/pw-entry.spec.ts (real keys and the real clipboard):
  - the unlock bar's boxes: their attributes, capitals, the caret moving on, Backspace, a pasted code, and Show;
  - the plain-field button;
  - the popup taking a code without hyphens in lower case, and a wrong one recorded once;
  - the words' hint, with spaces and capitals;
  - a new recovery key's prompt;
  - nothing on disk.
- Hand-made mutants, applied one at a time in a scratch copy, all 39 killed by the unit tests (revision 3's run, on
  the tree with enrolment-v2):
  - a second candidate for a shape the generator never makes (words with digits or 4 of them; 16 of any letter or
    digit);
  - two failures recorded for one attempt, at the lock screen or at step 4 (b);
  - an extra key derivation for every wrong password, or for one already in the generator's spelling;
  - the second spelling tried after any error, not only a wrong key; no `break` once a backup file opens;
  - the loose spelling refused at only one prompt, one mutant each: the export's check, the PIN box, a backup file,
    rotation and change, the lock screen, step 4 (b) of turning sync on, the first upload;
  - the hint trusted (a hinted unlock tries the generator spelling only);
  - a hint for a loose spelling, for a password of the user's own, or learnt from the typed shape;
  - the hint not bound to its wrap, its version ignored, written at every unlock, never learnt again after a restart,
    or left behind by a change or a reset;
  - the hint kept in `chrome.storage.local`, its store falling back to the storage helper's default, or the hint read
    with the pointer again;
  - the settings field swapped while typed in, or a late read applied over a newer one;
  - the boxes always `type="text"`, autocomplete on while masked, not emptied on `pagehide`, the value in
    `localStorage`;
  - the rotation re-wrapping with the typed spelling, and the first upload's verifier from it; the generator spelling
    tried before the typed one;
  - the subset guard back to bare NFKC, or without the generator spelling (B1).
- Revision 4, the popup's lock screen, with the fixes of its review (POPSEG-REVIEW, "r2"):
  - password-groups-dom.test.ts (new): the grouped input and the popup's lock screen rendered by Preact into a minimal
    document (test/helpers/mini-dom.ts; the project carries no jsdom), with events dispatched as a browser does. It
    checks what the component hands the page (the spelling with its hyphens, so one key derivation), pastes taken
    and refused, a 17th symbol refused, Backspace and the arrows, Show going off when the value empties, no Show
    with `showable={false}`, and an input method's composition and commit. For the lock screen it checks the boxes
    under the hint, never showable, sending the generator's spelling; a wrong try, then the plain field clearing the
    error and the value; the plain field without a hint or for words; and the PIN and recovery fields unchanged. A
    property checks that the boxes and the plain field's check take the same codes over 3,000 random strings.
  - password-entry-service.test.ts, through the popup's own wiring (`createPopupRuntime`). The view's `format` is
    checked when the record applies, is absent, is stale (another wrap) or damaged, sits in `chrome.storage.local`, or
    cannot be read; with a live PIN the view carries both. The lock screen's reads are exact: `sk_session`,
    `sk_quick` and the hint from the session area, and 3 local gets; none of the hint for an open with a live session.
    The boxes' value opens Sixkey with one key derivation. A forged or mistaken hint (16 symbols over 5 words, words
    over 16 symbols, 16 symbols over a user's own `supersecretpassw`) changes the field and nothing else, at the usual
    cost. Source rules check that the boxes appear for the master password only, never showable, that the plain field
    is one click away and clears the error, that neither `submit` nor `tryPin` reads the hint, that the record is read
    once and only in `openView`'s locked branch, and that the popup's code never touches it.
  - password-entry.test.ts: the editing steps under the shared reading (refusals, the arrows), and the key rules.
  - enroll-v2.test.ts: its rule that the popup never shows the master password now covers the boxes as well.
  - budget-split.test.ts: the popup's graph holds src/ui/PasswordGroups.tsx and nothing from src/options/.
  - pw-entry.spec.ts, with real keys and the real clipboard:
    - under the hint: the boxes' attributes and names, no Show, capitals, Backspace and the arrows, a wrong code pasted
      (one failure, `aria-invalid`), the right one pasted with hyphens in lower case into a box that holds some, Enter;
      then a wrong try, and the plain field, which clears the error;
    - without the hint: the plain field taking the code without hyphens in lower case, and the boxes back after that
      unlock;
    - a 16-symbol hint forged over 5 words: one click to the plain field, then unlocked;
    - an input method (Chrome's own composition, through CDP) in the settings page's boxes with Show on and in the
      popup's masked boxes;
    - the on-disk test types into the popup's boxes as well.
  - Hand-made mutants, applied one at a time, all 19 killed by the unit tests. The reviewer's survivors are now killed:
    an extra session read at the lock screen, the plain field leaving the error, the bare symbols handed over, Show not
    reset when emptied. So are the popup with Show again, no input-method guard, `onCompositionEnd` in Preact's camel
    case (which Chrome never fires), a key taken while composing, a throwing check giving the error screen, the arrow's
    extra press, other dashes dropped instead of refused, more than 16 cut off instead of refused, capitals before the
    check ("ß" as "SS"), and the six of the first round. Four of them (Show again, the error left, no input-method guard,
    the camel case) were also run against pw-entry.spec.ts, which killed each.
  - e2e, once and serially (`npm run e2e`), on the tree with AUTOFILL-PRE's revision 2, in a scratch copy with the API
    port moved from 8787 to 18787 everywhere it is spelled (the manifests, api-origin.mjs, check-dist, and the specs
    that listen on it: test/e2e/sync-helpers.ts and three in test/regression): 128 of 128 passed. pw-entry has 8
    tests. Revision 4's first run had moved the port only in the build, so the network regression specs found 8787
    taken. That run put those failures down to the environment; that was wrong. password-setup's "turn the master
    password on and change it" is flaky on the unpatched tree too. In repeated runs it failed 3 times in 38 patched
    and 2 times in 53 unpatched, both the same way: the old password went into the plain field while the hint was
    still arriving, and "Change password" stayed disabled. This change does not touch that form (MasterField changed
    only its import).
- One more mutant, for the e2e test (revision 1): the paste handler disabled, so a whole code pasted into a box that
  holds some comes out shifted. Killed by the unlock-bar test's real clipboard paste.
- e2e runs, each once and serially, in a scratch copy with the API port moved from 8787 to 18787 (8787 is held by an
  unrelated program): pw-entry, password-setup, firstrun, flows, export, export-selection, reset, quick-pin, errors, perf
  (its read gates included) and security-log. Revision 1: 77 of 77 passed. Revision 2: 77 of 77 passed. Revision 3:
  77 of 77 passed, and the sync join spec against the real server (test/sync/join.spec.ts): 2 of 2.

### 8.6 Decided and open

1. **The hint follows the shape: decided here.** It is written for a password that is exactly a generator spelling,
   whoever chose it. The service cannot tell who did, and an unlock learns it by shape anyway. Such a password of the
   user's own gets the grouped field, which takes it. Since revision 2 the record is never on disk (§8.1), so this
   tells a copy of the profile nothing.
2. **The hint in session storage only: decided** (owner, on review M3).
3. **The grouped input in the popup: done** (revision 4, §8.3), after the budget relief, within the popup's budget.
4. **The sync engine's key operations: open, before the gate opens** (§7.5, review M1). They check exactly, and the
   sync section's password prompts stay plain fields (that package's files). Turning sync on is covered (§7.2).
5. **Catalog headroom: open** (§6 item 3, §8.4): 55 B.
6. **Other dashes as separators** (U+2010–U+2015, U+2212; review m6): left out until the popup's budget allows.
