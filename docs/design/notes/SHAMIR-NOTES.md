# Recovery key shares (Shamir): design notes

> **Removed on 2026-11-25** (OWNER-DECISIONS/27): the shares are gone from the extension and from Sixkey for Mac, code,
> text and tests. The recovery key is used rarely, the day the master password is forgotten, and splitting it added
> things to keep, shares to gather and a reminder to answer. Version 0.1.4 and earlier are the last that make
> or read shares. These notes stay as the record of what was built; §6 and §7 (the lazy catalogs' budget and the lazy
> chunks' rules) still explain limits and module splits that outlived the feature.

The owner asked for "私钥分片" (OWNER-DECISIONS/15, 2026-10-22): split the recovery key into 3 shares, any 2 of which
recover it, with the master password the person's own and the PIN for every day. This is Feature B of
`docs/design/proposals/ADVANCED-RECOVERY-AND-TIERS.md` (§3), built as specified there unless §9 below says otherwise.
The owner's standing rule for it: "把功能做到极限但是不要复杂" (do it fully, but keep it simple).

Nothing here changes the keyring, the recovery wrap, the vault format, sync or the contract. Shares are only another way
to obtain the 128-bit recovery key secret R; Sixkey keeps no record of them (but the set id in a switch's reminder, §4). The feature is named with the site's word
for that key: **"Recovery key shares" / 恢复密钥分片** (OWNER-DECISIONS/16 question C, 2026-10-23: the recovery code is called the
recovery key everywhere; until then the feature said "Recovery code shares" / 恢复码分片, the earlier name). Every word of it is in
`scripts/i18n/shares.py`; the site-wide rename is `scripts/i18n/recoverykey.py` and the fragments that held the old word.

Revision 2 (2026-10-23) follows an independent review (`SHAMIR-VERIFY`, verdict "fix first"; the crypto core confirmed
against the reference). §12 lists each finding and what was done. The follow-up after its re-verification (SHAMIR-FU,
the review's r2.7 N1–N7, then its FU review's FU-1–FU-4) is §13.

## 1. What a person sees

Settings › Security › Password & recovery has a fourth fold, **Recovery key shares**, under Change master password, New
recovery key and Replace the encryption key. Opened, it is one screen at a time:

1. **Make shares.** "Any 2 of 3 (recommended)" or "Any 3 of 5"; then the source: "Make a new recovery key, shown only as
   shares (recommended)", which asks for the master password, or "Split my current recovery key", which asks for the code
   (typed, or rebuilt from shares: re-splitting a set). One button, Make shares. "Check my shares" is beside it.
2. **One share per screen**: "Share 1 of 3", the set id and the date, the share in 9 groups of 4 on the code card, what it
   is for ("Use it only in Sixkey ... not a crypto-wallet phrase. Never photograph it"). **Print share 1** (the printed page
   holds that share's paper only) and **Save as a text file** (with the warning that a download folder that syncs puts it
   in the cloud). No Copy. "Share 1 is printed or written down" is ticked before Continue. For "replace" every screen says
   "Nothing has changed yet: these shares open nothing until the check at the end."
3. **The test restore**: "Check 2 shares before we switch: type shares 1 and 3 back from your paper". The members are
   chosen by Sixkey at random, and the entry knows the set: a share of another set (an earlier, unfinished set's paper) is
   refused as it is typed, "This share is from set 1C3B. Type the shares of set 7F2A." For "replace", **Switch to these
   shares** commits the new code; for "split" the check is all there is and nothing is written.
4. **Done**, replace: "Any 2 of your 3 shares now rebuild your recovery key. Keep the old recovery key for now: after the
   next browser restart, use 'Check my shares' once, and destroy the old code only when they pass." Split: "... Your
   recovery key paper still works too." Both: "Lost a share? Make new shares with 'Make a new recovery key': the old code
   and every old share then stop working." The done screen keeps the mode, the threshold and the count, none of the shares.
5. **From the next browser start on**, after every unlock until a check passes: the popup shows one line and one button:
   "Check your recovery key shares once now. When they pass, destroy the old recovery key." / "Check my shares", which
   opens this fold at its check (also when the settings page first asks to unlock: the fold opens at that unlock). It
   goes when a check after the restart passes (§4).

**Check my shares**: type any threshold of shares; "These shares work", or "These shares rebuild a recovery key that does
not open this vault. They may belong to an older recovery key, or to another Sixkey vault (set 7F2A)." No screen tells
the person to destroy shares: the person at the screen cannot tell which vault a set is of. It writes nothing of the vault
and records nothing. After a switch whose reminder stands, two more lines:

- a pass before the browser has restarted: "The browser has not restarted since you switched to these shares. Check them
  once more after you restart it, and destroy the old recovery key only then." The reminder stays;
- a failure after the restart, of shares of the switched set (the reminder holds its id): "If these are the shares you
  switched to last, that switch did not complete: your old recovery key still opens your vault. Keep it, and make the
  shares again." The reminder stays. Shares of any other set get the stale line only.

**I have shares instead**, on every field that takes the recovery key: the popup's and the side panel's lock screen
(Use recovery key), the reset in a settings tab (Forgot the password), the shares wizard's "split my current code", and
the Sync section's four recovery key fields (turning sync on, the recovery join, the key operations, the repair; behind
the release gate). The entry asks for one share at a time ("Share 1", then "1 of 2 shares typed (set 7F2A)"); each share
leaves the field once it is read; with the threshold typed the code is rebuilt and used exactly as a typed one.

**Every recovery key change says the shares stop working**: New recovery key and Replace the encryption key (their
folds), the reset (its form), the first run when it replaces a vault (Start over, a restore over unreadable data; not a
new profile's first run, where no shares can exist), the Sync section's new codes (turning sync on with a new code, the
key operations' and the revocation's new code). The line is one key (`sharesStopWarn`) in the settings page's core text.
The Sync section's join and repair take the existing code and make none.

## 2. The arithmetic and the format (`src/core/crypto/shares.ts`)

**SLIP-39's sharing for one group, byte for byte** (proposal §1.2, §3.3): GF(2⁸) with the Rijndael polynomial, Lagrange
interpolation; for a threshold t ≥ 2, t − 2 random shares at x = 0 … t − 3, the digest share
`HMAC-SHA256(key = r, msg = R)[0..4] ‖ r` (r: 12 random bytes) at x = 254, R at x = 255, the other members at
x = t − 2 … n − 1; recovery interpolates at 255 and 254 and checks all 4 digest bytes in constant time. Random bytes are
drawn in the reference's order and nothing is rejected. No table indexed by secret bytes in the field: multiplication is
shift-and-XOR with masks, inversion a²⁵⁴ (the text codec, like the recovery key's, still indexes a 32-character
alphabet). No Feistel layer, no groups, Sixkey's own text.

**Text, v1**: 180 bits, 36 Crockford symbols in 9 groups of 4: version 1 (4 bits), kind 0 (4 bits; 1 reserved for an
heir share), set id (16 bits, random), threshold − 1 (4), member index (4), the share value (128), and a **20-bit CRC**:
generator x²⁰ + 0xFD2A9 (0x1FD2A9, primitive), over "sixkey-share|1|" then the first 20 bytes (the tag's bytes are the
register's start), most significant bit first, computed with masks rather than branches on the bits. Read as the recovery
code is (any case; spaces, hyphens, underscores; O as 0, I and L as 1).

What the check **guarantees**, for every share: the 36 symbols are exactly the 180 bits and the check exactly the last 4
symbols, so an error confined to 4 consecutive symbols is a burst of at most 20 bits, which a degree-20 CRC with a constant
term always detects: every single-symbol substitution and every swap of two neighbours. With this generator the 1,116
single-symbol errors (36 places × 31 values) also have 1,116 distinct non-zero syndromes, so every two substitutions
anywhere are detected too. Anything else passes with about 2⁻²⁰, and then the digest stops it but for 2⁻³². (The first
version used 20 bits of SHA-256, which catches a typo with probability 1 − 2⁻²⁰ only: the review found 3 single-symbol
typos in 4.5 million that passed. The format had not shipped.) The recovery key's own check, 12 bits of SHA-256, is
unchanged: Phase 0's codes are already given out, and it is not this feature's to change.

A failing check is a typo; a share whose check holds but whose version or kind is unknown "was made by a newer Sixkey" (a
later version of the same length keeps v1's check over its first 20 bytes for that reason). A recovery key and a pairing
code are 28 symbols: neither is ever read as a share, nor a share as either; the tag separates the domains besides. A set
is refused before any arithmetic unless it is exactly t shares with one set id and one threshold and distinct members; a
set never has t below 2 (each share would be R itself).

**Checked against SLIP-39's official vectors, at the level of the shares and the digest**
(`test/unit/shares-slip39.test.ts`):

- The fixtures are made by `test/fixtures/shares-slip39-gen.py` (Sixkey's script) from `trezor/python-shamir-mnemonic`
  at commit `1ff7b9a9` (PyPI 0.3.0), run outside the tree (`python3 -I`, the reference's package in a directory of its
  own, the generator in another), into two files:
  - `test/fixtures/shares-slip39.json`: every official vector decoded with the reference's own decoder into raw member
    shares (x, value); the 27 that decode: 15 valid sets (128- and 256-bit, one group and two groups, the "modular
    arithmetic" vector, the extendable ones) and 12 invalid ones. Derived from MIT-licensed vectors: REUSE.toml marks
    this file, and only this file, MIT;
  - `test/fixtures/shares-cross.json`: Sixkey's own secrets and random streams through the reference's `_split_secret`,
    and what it gave: Sixkey's, under the extension's licence.
- The member level, Sixkey's one level, goes through Sixkey's own `combineShares` wherever a group's member threshold is 2
  or more. For each valid set that gives the reference's encrypted master secret (member level, then group level), and
  that value decrypted with SLIP-39's Feistel cipher (reimplemented in the test only) and the passphrase "TREZOR" is the
  vector's master secret.
- Of the 12 invalid vectors, **8 apply to Sixkey and are refused by its `combineShares`**: 5 and 24 (too few members), 11
  and 30 (the same member twice), 13 and 32 (the digest), 16 and 35 (too few members in one group). **4 do not apply**:
  14, 15, 33, 34 fail only at the group level (too few groups), which Sixkey does not have; the test refuses them with
  the reference's count rule, written in the test. Changing one byte of a member share fails the digest in every valid set
  with a member threshold above 1, and a digest share off in any one of its 4 bytes is refused.
- The split: for 2 of 2, 2 of 3, 3 of 5, 4 of 7, 5 of 16, 16 of 16 and 1 of 3, Sixkey's split, given the reference's
  random bytes, draws them in the same order and sizes and gives the same member shares; every subset of the threshold
  recovers.
- The vectors' SHA-256 is pinned in the test. No dependency was added: the reference is only run to make the fixtures.

## 3. The service (`src/core/service/service.ts`, `VaultService`; not in the popup)

- `prepareShares({password} | {recoveryCode}, {threshold, count})`, in memory, nothing of the vault written:
  - **replace**: `noSync` first (with sync on: `sync_on`, before the password is checked: the new recovery wrap would have
    to go through the server, as the sync key operations do); then the master password (`verifyPassword`: a wrong one is
    refused and recorded as `unlock_failed`), an unlocked vault (`locked`), a recovery wrap (`not_protected` for a Phase 0
    device-key vault); `setRecovery` makes the new keyring in memory; R is split and zeroed.
  - **split**: an unlocked vault; the typed code must open the current wrap (a wrong one is refused and recorded as
    `recovery_failed`, as everywhere a recovery key is typed; a malformed one is a typo, not recorded). Allowed with sync
    on: nothing of the vault is ever written for it. The set made is recorded as `shares_made` (a kind and a time, as an
    export is: the strongest root copied once more).
  - the members to type back are drawn uniformly (a partial Fisher-Yates shuffle by rejection sampling).
  - the handle (`PreparedShares`: mode, set id, threshold, count, the share texts, the members to type back) is frozen and
    carries no code and no key; the new keyring, its vault key and the keyring the set was made against stay in a
    module-level `WeakMap`, as `prepareReset`'s do.
- `confirmShares(handle, typed)`: the typed shares must be of this set (`shares_mixed`) and exactly the members asked for
  (`bad_state`); they are combined, and
  - **replace**: the rebuilt code must open the **new** keyring's recovery wrap (`bad_state` otherwise: a forged set with the
    same id, threshold and members is refused), so what is committed is what the shares rebuild. Then one locked save
    (`store.transact`), as `newRecoveryCode`'s: a save that already landed counts as done (`LANDED`); `sync_on`; the keys
    changed since the set was made (`bad_state`, writing nothing); Sixkey locked meanwhile (`locked`). These are checked
    once before the save, refusing with nothing written, and again under the store's lock. Between the two, the reminder
    is set (§4), with a random id of this switch and the set's id: before the save, so that no lost write keeps the
    commit and drops it. A save refused after it runs `unremind` (review FU-1), in this order: (1) the reminder was not
    written, or not known to be: nothing; (2) the keys cannot be read: it stays; (3) the keys are this switch's (the save
    landed after all): it stays; (4) else the reminder from before goes back, under the security record's own lock, only
    while the one there is still this switch's (`putBack`, comparing the random id, as two switches can share a
    millisecond): another page's switch written since, or a drop by a recovery key change since, is left alone. After
    it, `committed("recovery_code_new", …, {keepRemind})`:
    the record, the PIN's session ended, the cleanup, as for a new recovery key, with this switch's reminder kept. No
    code is delivered: the shares were shown before.
  - **split**: nothing written; the code must open the vault now (`wrong_secret`: it changed meanwhile).
- `checkRecoveryCode(code, set?)`: "current" or "stale"; writes nothing of the vault and records nothing. It needs an unlocked
  vault, so it is no oracle for someone at a locked page, where every recovery key typed is recorded. With a switch's
  reminder standing (the security record's `checked`): a pass before it is due is "current_before_restart" and keeps it
  (a check before the restart proves nothing about the commit); a pass once it is due is "current" and drops it, the one
  thing this writes; a failure once it is due, of shares of the switched set (`set`: the wizard reads it from the typed
  shares), is "stale_after_switch" (review FU-2).
- A new vault (`makeVault`: a first vault, a backup restored, Start over) drops the reminder: the security record outlives
  the vault, and the vault before's shares can never pass in the new one.
- `browserStarted()`: the service worker's `onStartup` and `onInstalled` call it; a reminder set before becomes due. An
  update of Sixkey makes it due without a browser restart; its words therefore do not say the browser restarted, and an
  update moments after a switch, then a power loss, is the one case it reminds too early.

The popup's lock screen and the reset take the rebuilt code through their existing paths (`unlockWithRecoveryCode`,
`prepareReset`): they record `recovery_used` / `recovery_failed` exactly as for a typed code.

**The reusable step** (proposal §0.3, §5.1: "enter your recovery key, two shares, or make a new one", which protected
accounts and the inheritance kit will need), built once, in two halves:

- the service's: `VaultService.recoveryKeyFrom({password} | {recoveryCode})` (private), which `prepareShares` calls: the
  code in hand, either the current one verified against the current recovery wrap (typed, or rebuilt from shares), or a
  new one prepared in memory and not committed, with all the rules above (`sync_on` before the password, the records,
  `locked`, `not_protected`);
- the page's: `options/RecoveryKeyStep.tsx`, the choice and its field (the master password for a new code;
  `RecoveryCodeInput`, the code field with "I have shares instead", for the current one), with the caller's words, and
  `recoveryKeyOf`, what it hands to the service.

A later feature takes the code through these instead of writing a second way to it.

## 4. Never lose data

- **Nothing is committed until the test restore succeeds**, and the service enforces it, not only the page: the commit
  takes the typed shares and checks them. **The old recovery key stays valid until the commit**, which is one locked save
  of the keyring as a new recovery key's is.
- **The order of writes**: `test/fault/shares-commit-crash.test.ts` interrupts the commit at every write (local storage,
  the mirror, the session), just before and just after it lands, and restarts: in every case the master password opens
  every account and **exactly one** of the two codes opens the vault (never neither); both outcomes occur. A commit whose
  pointer write landed, reported an error and could not be taken back is finished by the same handle (`LANDED`), never
  refused as "keys changed".
- **A set made and not finished** (the fold closed, a lock, a hidden tab, leaving the leaf, the page closed: it asks first)
  changes nothing; its shares open nothing. The share screens say so; "Check my shares" later reports such a set as one
  that does not open this vault, and the test restore of a later set refuses its papers as another set's.
- **Residual, as for every key change** (local-vault.md "Interrupted key changes"): a power loss that drops the commit's
  last write after "Done" was shown rolls it back at the next start; the old code works again and the shares do not.
  Shares invite destroying the old paper, so (review F1):
  - the done screen says to keep the old code until the shares pass "Check my shares" after the next browser restart;
  - **the reminder**: `remind: {kind: "shares", at, due: false, id, set}` in the security record (`id`: random, the
    switch's own; `set`: the set's id, printed on every share), written just before the commit's save. The security record is in the same storage as the vault (`chrome.storage.local`), whose writes are lost newest
    first, so a loss can drop the commit and keep the reminder, never the reverse; the crash test holds it at every write
    (whenever the new code is in force, the reminder is there and the popup shows it). The next start of the browser
    (`onStartup`) or of Sixkey (`onInstalled`: an update, or the command-line load the browser tests use; Playwright's
    relaunch fires no `onStartup`) makes it due; the popup, which reads that record once after an unlock anyway (no new
    read: `read-budget.test.ts` and the perf gates are unchanged), shows its line and button after every unlock until a
    check passes. It goes when "Check my shares" passes once it is due (a pass before the restart keeps it and asks for
    one more after it), with a new vault, and with any other recovery key change (`committed`). A refused switch takes
    back only its own (§3), so two pages switching at once, or a switch racing a password change, never drop the
    reminder another switch still needs (the review's two races are tests). No secret: a time, a random id, the set's
    id (on every share). A record cleared by the person drops it too.
  - **A reminder left by a switch that did not land** (the power loss came before the save, or the save was refused and
    the reminder could not be put back) is never silent: its check of the switch's shares (the reminder's set), after the
    restart, says that the switch did not complete and the old code still opens the vault. Nothing tells the person to destroy anything
    until shares pass. The reminder then stays until shares pass, a new code is made, or the record is cleared.
  - Only a check after a restart shows that the switch survived: before it, the commit is durable only as far as the
    browser's last writes are.
  - **Known, left** (review FU-4): a reminder that cannot be written (a security record of a newer version, a failing
    write) never holds the switch back, so such a switch completes without one; the done screen still says to keep the
    old code until a check after the next restart. And (FU-3, behind the release gate) keys adopted through sync
    (`keys_adopted`, `keys_adopted_back`, `identity_restored`) do not end a reminder: a check then could say "your old
    recovery key still opens your vault" of a code the adopted keys replaced. For when the Sync section is finished.
    The master password still opens the vault in every case.

## 5. The pages

- **No new leaf.** The recovery key is managed in Password & recovery; a fourth fold costs one line there (folds are
  closed on every opening). The wizard and its text are lazy (§6), loaded when the fold opens. The fold closes on a lock,
  a hidden tab, Escape and leaving the leaf, as the others do, and the wizard goes with it. `#shares` (the popup's
  reminder) opens Password & recovery with the fold open at "Check my shares"; on a page that has to unlock first
  (Sixkey set to lock every time), at the unlock that follows, once. The switch is the page's key operation
  (`key-ops.ts confirmShares`): the page asks before it is closed while it runs, and its outcome reaches the leaf the
  person moved to.
- **Errors of the shares are said in the shares' words**: the wizard hands the page's key operation a mapper
  (`sharesWords`: another set, a typo, the same share, a set that does not fit), so a paper of another set is never "Sixkey
  could not read its data ... restore from a backup", and leaves no diagnostics line. The mapper is the wizard's (its text
  is the lazy catalog), not `ui/errors.ts`, which is in the popup's bundle. A test runs it through the real `useKeyOps`.
- **What the pages hold.** The share entry (`ui/ShareEntry.tsx`) is a password field until Show, autocomplete off, no
  name; the typed shares are in its state only (their text is what is combined; the parsed values are zeroed). It lets go
  of everything, and tells the host, at a lock from any page (the lock epoch), when the page goes away, with "Start again"
  and when it is unmounted. Its list of typed shares carries `data-sk-held`, which the side panel's lock-screen wipe
  (`src/sidepanel/main.tsx`) counts as typed, so held shares go after 2 idle minutes as a typed code does. The rebuilt
  code goes to the host's existing path and nowhere else; R is zeroed. The wizard's done screen keeps no share.
- **Print** puts one share's paper (its text set as text) under `<body>` for the print only, hides the rest of the page in
  the print view (`share-wizard.css`), and removes the paper when printing is over. Never a URL, never all shares on one
  page. **Save** writes one share per file: `sixkey-share-<set>-<i>-of-<n>.txt`.
- **No Copy**, anywhere in the shares (a test holds the pages to it).
- **The Sync section's recovery key fields** take shares too, but do not yet say "these shares are of an old code" when
  the flow refuses the code: they show the flow's own failure line beside "recovery key rebuilt from 2 shares" (review
  F11). Passing `stale` needs each flow's failure to say it was the code; left for when the Sync section is finished (it is
  behind the release gate).

## 6. Text: a lazy catalog of its own, outside the 12 KB aggregate, the page with it at most 15 KB

The shares' text did not fit the settings page's parts: their "every part" aggregate had about 330 B left of 12,288.
It is a **lazy catalog of its own**, `catalogs/shares-<lang>.json` (`scripts/i18n/shares.py` `SHARES_EN`/`SHARES_ZH`, keys
disjoint from every other catalog), loaded with the shares' lazy chunks through `ui/share-text.ts` (`lazyText`, as the
View menu and the Fill button), by the popup, the side panel and the settings page alike. Why not a seventh settings
part: the popup's lock screen needs the entry's text too, and a part is the settings page's only; one catalog keeps one
copy of the words and one place to rename them.

- Its budget: 3,072 B gzipped (measured 1,674 B zh_CN in revision 2), in `messages.py` `BUDGETS["shares"]` and check-dist
  `SHARES_CATALOG_GZ`, held equal by `budget-split.test.ts`.
- **The owner's decision (2026-10-23): the lazy catalog stays outside the 12,288 B aggregates**, and what a vault's page
  holds with it in (its view's parts and the shares' catalog as one gzip stream) is held to **15,360 B** = 12,288 + 3,072:
  `messages.py` `SHARES_PAGE_LIMIT` and check-dist `SHARES_PAGE_GZ`, equal by `shares-check-dist.test.ts`, which also
  tampers a build over it. Measured 12,753 B (zh_CN). BUDGET-NOTES.md §7 has the line.
- check-dist: one entry chunk, one wizard chunk and one text chunk per language; each text chunk exactly the generated
  file, within budget, with keys of no other catalog and the same keys in every language; none of them in any page's
  static graph; the entry and the text reachable from the popup, the side panel and the settings page, the wizard from the
  settings page only. The collector treats the shares' catalogs as text (`popupKeys` `pageCatalogs`).
- Keys in the full catalogs, drawn before the lazy text can be: `sharesInsteadLink` (the popup's catalog and the settings
  core), `sharesStopWarn` and `sharesSwitched` (core), `sharesFoldTitle` and `secKSharesMade` (security), `sharesRemind`
  and `sharesRemindGo` (the popup's only). **The every-part aggregate is at 12,094 of 12,288 B (zh_CN): about 194 B
  left.** The next feature's settings text needs a lazy catalog of its own, or text moved out.

## 7. The popup's budget: a lazy chunk must not import the main chunk's modules

Measured, with the release gate open and closed: the share entry importing `platform/session.ts` (for the lock epoch's
key) or, with the gate open, `core/crypto/recovery-code.ts` or `core/crypto/bytes.ts` (through `shares.ts`) moved those
modules out of the popup's main chunk into a chunk of their own, which cost the counted bundle 520 to 640 B: the bundler
groups modules by the set of entries (lazy ones included) that reach them, and two gzipped chunks compress worse than one.
So:

- `CryptoError` and the Crockford reading are leaf modules (`core/crypto/crypto-error.ts`, `core/crypto/crockford.ts`,
  importing nothing; `bytes.ts` and `recovery-code.ts` re-export and use them, unchanged for every caller);
- `shares.ts` imports only those two (the CRC needs no hash; the digest uses WebCrypto's HMAC);
- the entry gets the lock epoch's key and the recovery key formatter from its host as props (`lockKey`, `toCode`);
- `test/unit/shares-rules.test.ts` holds these imports, and that the popup, the settings page and the wizard load the
  entry and the wizard by `import()` only.

Revision 2's reminder adds about 400 B to the popup (the security record's reminder field and its two methods, which the
popup's copy of the record's class carries; one notice line; two keys). Within budget; moving the record's write methods
out of the popup's class would save part of it if room is needed later.

The figures are check-dist's, on the store build (gate open: the same build with `SYNC_UI_IN_STORE_BUILD` set);
`messages.py`'s own gzip gives a few bytes less for the catalogs.

| Gzipped bytes                          | before | revision 1    | revision 2              | follow-up               | limit      |
| -------------------------------------- | ------ | ------------- | ----------------------- | ----------------------- | ---------- |
| popup, gate closed                     | 55,957 | 55,997        | 56,388                  | 56,585                  | 61,440     |
| popup, gate open                       | 57,168 | 57,230        | 57,619 (headroom 3,821) | 57,818 (headroom 3,622) | 61,440     |
| side panel, gate closed                | 58,171 | 58,230        | 58,619                  | 58,816                  | 63,488     |
| side panel, gate open                  | 59,389 | 59,475        | 59,865                  | 60,063                  | 63,488     |
| settings core (zh_CN)                  | 3,740  | 3,829         | 3,855                   | 3,855                   | 5,120      |
| settings security (zh_CN)              | 3,327  | 3,347         | 3,355                   | 3,355                   | 5,120      |
| other settings parts                   |        | unchanged     | unchanged               | unchanged               | 3,072 each |
| settings, a vault's page (zh_CN)       | 11,440 | 11,535        | 11,572                  | 11,572                  | 12,288     |
| settings, every part (zh_CN)           | 11,962 | 12,057        | 12,094                  | 12,094                  | 12,288     |
| shares (lazy, zh_CN / en)              |        | 1,540 / 1,249 | 1,674 / 1,373           | 1,779 / 1,477           | 3,072      |
| a vault's page with the shares (zh_CN) |        | 12,625        | 12,753                  | 12,848                  | 15,360     |

## 8. Tests and mutants

### 8.1 Tests

- `test/unit/shares-crypto.test.ts` (39): GF(2⁸) against log/exp tables for all 65,536 products and every inverse, the
  FIPS-197 examples, no table in the field's code; interpolation as a property (random polynomials of degree up to 7, any
  t points, any x); the digest against node:crypto's HMAC and its place (x = 254, digest ‖ r), and a digest share off in
  each one of its 4 bytes refused; split and recover as properties (random secrets, every t-subset recovers; fewer than t:
  a set refuses them, the raw arithmetic gives something else and fails the digest); one share's bytes unforced (no
  zero-coefficient rule); the random bytes drawn as the reference draws them; the text's known answer (the CRC computed
  independently, by long division); **the check's guarantee on 120 random shares: all 36 × 31 substitutions and all 35
  swaps of neighbours caught**; why it holds for every share (the 1,116 syndromes distinct and non-zero, bursts of up to
  20 bits never divisible); two substitutions anywhere caught (sampled); a first-symbol typo a typo and not "newer";
  another version or kind "newer"; the domain tag; a recovery or pairing code never a share and back; errors without
  input; a set: different sets, the same share, more or fewer than t refused before any HMAC; a set-id collision fails
  the digest; R zeroed after the formatter had it; zeroing.
- `test/unit/shares-slip39.test.ts` (37): §2.
- `test/unit/shares-service.test.ts` (40): replace (prepare writes nothing; the commit only with the members asked for;
  3 of 5; other members, too few, another set, a typo refused and nothing written; a forged set with the same id refused;
  keys changed meanwhile; locked meanwhile; a save that reported an error; the password checked and recorded; locked and
  device-key vaults; the set's shape; the members drawn uniformly), split (only `shares_made` recorded, nothing of the
  vault; the loose reading; a wrong code recorded, a malformed one not; the code changed meanwhile), check (current, the
  reminder dropped, then nothing written; stale; locked), no persistence; **the review's R4** (another set of the same code
  at the test restore: `shares_mixed`, split and replace), **R5** (a commit that landed and stayed, finished by the same
  handle), **R6** (sync turned on between the set and the switch: `sync_on`, nothing written); the reminder (set by the
  switch, due after a start, gone when the check passes, kept by a stale check, dropped by another recovery key change,
  never set by a split, nothing secret in it); **the follow-up** (36 in all): a pass before the restart keeps it (N1),
  every new vault drops it (N2: a first vault, a backup restored on an empty or an unreadable store, Start over), and the
  switch's save (N7): the reminder written before the pointer, no write at all for a switch refused before the save, put
  back exactly (an earlier switch's, due) when refused under the store's lock, none after another key change came first,
  kept when the save landed and could not be taken back, taken back with a save that was; **FU-1** (40 in all): the
  reviewer's two races with two pages over one storage (two switches at once; a switch raced by a password change, an
  earlier switch's reminder due), a reminder whose write reported an error, the keys unreadable after a refusal; FU-2:
  "that switch did not complete" for the switched set's shares only.
- `test/unit/shares-remind.test.ts` (11): the security record's reminder (stored, due, kept by entries and acks, dropped by
  null and by clearing, no write without one, a damaged one dropped, a newer version's record left alone, a read that
  throws), `putBack` (only while the reminder is that id's, exactly as it was; two switches in one millisecond told
  apart by their ids; an id or set id that is not one left out when read), `checked` (a pass drops only a due one; the
  set's id), and the popup's notice with it.
- `test/fault/shares-commit-crash.test.ts` (1): §4; with the security record in the same storage: at every crash point
  whose outcome is the new code, the reminder is there and the popup shows it after the restart; at every one that kept
  the old code with a reminder left, a check of the switch's shares says the switch did not complete.
- `test/unit/m3-keys.test.ts` (+1): with sync on, "replace" is refused before the password is checked.
- `test/unit/shares-dom.test.ts` (19): the entry (read as typed, the field emptied, the threshold, typos, other sets, the
  set it is bound to, the same share, `want`, shares that do not fit, every wipe and that it tells the host, stale without
  "destroy", no text at all), the settings input (the code handed over as typed symbols, back to the field), the wizard
  (one share per screen, "kept", Switch only after the test and through the page's key operation, a paper of an earlier set
  refused at the test, the shares' words for the page, no share on the done screen, a refused switch, print and save one
  share, split, check, the errors in words).
- `test/unit/shares-check-dist.test.ts` (17): against real prod and e2e builds, check-dist fails on the shares' text over
  its limit (both builds), a vault's page with it over 15 KB, a text chunk missing, one that is not the generated file, a
  shares key that is a full catalog key, two entry chunks, the entry in the popup's static graph, the wizard reachable
  from the popup; messages.py refuses a shares key of another catalog (the full ones, the Fill button's), one added twice,
  the languages differing, the catalog over its budget, and writes nothing then; the 15 KB limit is the view limit plus
  the shares' budget in both scripts.
- `test/unit/shares-rules.test.ts` (9): §7's imports, `import()` only, nothing kept (no storage, log, clipboard, address or
  message), the done screen's step, the service worker's two start hooks making the reminder due (the browser tests reach
  only `onInstalled`), the fields' attributes, the Crockford reading shared with the recovery key.
- Updated source rules: `enroll-v2.test.ts` (the recovery key fields now through RecoveryCodeInput, and the entry's field
  held to the same rules), `password-entry-service.test.ts` (the lock screen's form, its new `attempt`),
  `autofill-pre-source-rules.test.ts` (the entry listens to the lock epoch), `budget-split.test.ts` (the service's new
  members and handle, the shares budget), three `KeyOps` fakes. `short-settings-dom.test.ts` (+1, the follow-up's N5):
  `#shares` on a locked page opens the shares fold at the unlock, once.
- `test/e2e/shares.spec.ts` (6), in Chromium: replace 2 of 3, printed (the print view shows that share only, and the paper
  is gone after) and saved (one share per file), the test restore (the member not asked for refused), switched, the done
  screen saying to keep the old code, then the popup's lock screen refuses the old code and unlocks with two shares
  (recorded as a recovery key); split, nothing written, check, a new recovery key (its warning), then the same shares
  stale in the wizard and on the lock screen; the reset with shares; the side panel's lock screen wiping held shares after
  2 idle minutes; Start over saying the shares stop working, a new profile's first run not; **a paper of an earlier set
  refused at the test restore, a check at once asking for one more after the restart, no reminder before a restart, the
  reminder after the browser restarts, its button opening the check, gone once the check passed**.
- `test/e2e/visual-guard.spec.ts`: the shares fold open at 320, 420 and the default width.

### 8.2 Hand-made mutants

Each applied alone to a throwaway copy of the tree, its tests run, then reverted; a kill counts only when a test assertion
fails (the logs were checked for load errors). Revision 2: **64 mutants, 64 killed** (the first version's C1–C3 mutated
the SHA check, which is gone; K1–K5 mutate the CRC):

|     | Mutant                                                               | Killed by                                         |
| --- | -------------------------------------------------------------------- | ------------------------------------------------- |
| G1  | GF(2⁸): reduction polynomial 0x11D                                   | crypto, SLIP-39 vectors                           |
| G2  | GF(2⁸): inverse a¹²⁸                                                 | crypto, SLIP-39 vectors                           |
| G3  | interpolation: the Lagrange denominator over (x − xⱼ)                | crypto, SLIP-39 vectors                           |
| D1  | digest: HMAC key and message swapped                                 | digest test, SLIP-39 vectors                      |
| D2  | digest share laid out r ‖ digest                                     | digest test, SLIP-39 vectors                      |
| D3  | recovery: the digest not checked                                     | digest refusals, invalid SLIP-39 vectors, service |
| R1  | digest: only the last byte compared (review)                         | the digest-byte tests                             |
| S1  | split: members at x = 1 … n                                          | properties, the cross-check                       |
| S2  | split: r drawn before the random shares                              | the cross-check, the draw order                   |
| S3  | split: the digest's random part not uniform                          | the cross-check                                   |
| K1  | check: a generator without its constant term                         | the exhaustive typo test, the syndromes           |
| K2  | check: the tag not in the register's start                           | known answer, domain separation                   |
| K3  | check: 16 of the 20 bits compared                                    | the exhaustive typo test                          |
| K4  | check: the data bits not fed in                                      | the exhaustive typo test, known answer            |
| K5  | check: another generator (x²⁰ + x³ + 1)                              | the syndromes test, known answer                  |
| T1  | threshold: more than t accepted                                      | set test                                          |
| T2  | threshold: fewer than t accepted                                     | fewer-than-t property                             |
| T3  | threshold 1 allowed                                                  | set test                                          |
| I1  | set id not compared                                                  | "different sets before any arithmetic"            |
| I2  | the threshold not compared                                           | "same set id, another threshold"                  |
| V1  | stale detection: reported current                                    | check test                                        |
| V2  | commit only after the test: any members                              | service: other members, too few                   |
| V3  | the shares' code not checked against the new keyring                 | service: forged set                               |
| V4  | the base keyring not compared                                        | service: keys changed meanwhile                   |
| V5  | commit written while locked                                          | service: locked meanwhile                         |
| V6  | the new keyring written at prepare                                   | service: prepare writes nothing                   |
| V7  | split: a wrong code not recorded                                     | service: recovery_failed                          |
| V8  | replace: the master password not checked                             | service: unlock_failed                            |
| V9  | the members to type back not random                                  | service: uniform draw                             |
| V10 | the rebuilt code kept in session storage                             | service: no persistence                           |
| V11 | the password checked before `sync_on`                                | m3-keys                                           |
| R4  | commit: the typed shares' set id and threshold not compared (review) | service: another set of the same code             |
| R5  | commit: LANDED checked after the base compare (review)               | service: a commit that landed and stayed          |
| R6  | commit: `noSync` dropped inside the transact (review)                | service: sync on between the set and the switch   |
| F1a | reminder not set at the switch                                       | service, reminder tests                           |
| F1b | reminder never due at a start                                        | service, reminder tests                           |
| F1c | reminder not dropped when the check passes                           | service                                           |
| F1d | `onStartup` not making the reminder due                              | rules                                             |
| F9  | split: `shares_made` not recorded                                    | service                                           |
| U1  | entry not wiped at a lock                                            | DOM                                               |
| U2  | entry not wiped at pagehide                                          | DOM                                               |
| U3  | the code handed over before the threshold                            | DOM                                               |
| U4  | `want` not enforced                                                  | DOM                                               |
| U5  | a plain text field                                                   | DOM                                               |
| U6  | the same share twice not refused                                     | DOM                                               |
| U7  | another set not refused before combining                             | DOM                                               |
| F2  | test restore: a share of another set accepted while typed            | DOM                                               |
| W1  | Switch before the test restore                                       | DOM                                               |
| W2  | every share on the paper and in the file                             | DOM                                               |
| W3  | the next share without "kept"                                        | DOM                                               |
| W4  | the rebuilt code not handed over as typed symbols                    | DOM                                               |
| F2b | the switch's errors in the page's words ("could not read")           | DOM                                               |
| F5  | the done screen keeping the shares                                   | rules                                             |
| P1  | the side panel's wipe not seeing held shares                         | e2e (side panel)                                  |
| P2  | the popup not saying a set is stale                                  | e2e (split)                                       |
| P3  | the print view printing the page with the share                      | e2e (replace)                                     |
| P4  | the popup not showing the due reminder                               | e2e (restart)                                     |
| B1  | check-dist: the shares' text not held to its limit                   | shares-check-dist                                 |
| B2  | check-dist: a shares key of the full catalog allowed                 | shares-check-dist                                 |
| B3  | check-dist: the shares' chunks allowed in a static graph             | shares-check-dist                                 |
| B4  | check-dist: the wizard allowed in the popup                          | shares-check-dist                                 |
| B5  | messages.py: a shares key of another catalog allowed                 | shares-check-dist                                 |
| B6  | messages.py: the shares' budget ten times larger                     | shares-check-dist, budget-split                   |
| B7  | check-dist: the page with the shares not held to 15 KB               | shares-check-dist                                 |

The review's other survivors are left as they are: R8 (the members' draw without rejection sampling: a bias under 1/256
on which members are asked for, which is public), R13 (the entry not comparing thresholds after the first share: only the
message differs, since the set it is bound to, or `combineShares`, refuses it), R14 (a parsed value not zeroed in the
entry: best effort in JavaScript). R15 (R not zeroed by `recoveryCodeFromShares`) now has a test.

They were run in a private copy, as for earlier work; the table is the record.

The follow-up (§13), after the review's FU-1 fix: **25 mutants, 25 killed** (`patches/mutants-fu.py`): its own, those
of FU-1's four rules and the switch's id, FU-2's, and four of revision 2's again on the save's conditions, which moved
into one function checked before the reminder and again in the save:

|     | Mutant                                                                        | Killed by                                              |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| N1a | `checked`: a pass drops a reminder not yet due                                | service (N1), reminder tests                           |
| N1b | a pass before the restart reported plain "current"                            | service (N1)                                           |
| N1c | the wizard without "check once more after the restart"                        | DOM                                                    |
| N2  | a new vault keeps the reminder of the vault before                            | service (N2: all four ways)                            |
| N3  | `key-ops.ts`: the wizard's words ignored (the review's B3)                    | DOM, through the real `useKeyOps`                      |
| N5  | the shares fold not opened at the unlock after `#shares`                      | `short-settings-dom`                                   |
| N7a | the reminder set after the commit (revision 2's order)                        | crash test ("committed without its reminder"), service |
| N7b | a refused save leaves the reminder set                                        | service (N7)                                           |
| N7e | the commit's cleanup drops the switch's own reminder                          | service, crash test                                    |
| N7f | a failed check after the restart never says the switch may be lost            | service, crash test ("not told")                       |
| N7g | no check before the reminder: a refused switch writes the record              | service (N7)                                           |
| U1  | rule 1 gone (the review's U10): a reminder not known to be written taken back | service (FU-1 rule 1)                                  |
| U2  | rule 2 gone: the keys unreadable, the reminder taken back                     | service (FU-1 rule 2)                                  |
| U3  | rule 3 gone (the review's U9): a save that landed has its reminder taken back | service (landed and stayed)                            |
| U4  | rule 4 without the compare: put back over another switch's reminder           | service (two switches at once), reminder tests         |
| U5  | rule 4 drops instead of restoring (the first follow-up's "null" branch)       | service (the password-change race)                     |
| U6  | the switch's id a constant                                                    | service (two switches at once)                         |
| U7  | the switch's id from the time                                                 | service (two switches at once, one millisecond)        |
| S1  | "the switch was lost" for shares of any set                                   | service (FU-2)                                         |
| S2  | the wizard does not say which set the shares are of                           | DOM                                                    |
| S3  | the switch's reminder without the set's id                                    | service, crash test                                    |
| R5  | LANDED checked after the base compare                                         | service                                                |
| R6  | `noSync` dropped from the save's conditions                                   | service, m3-keys                                       |
| V4  | the keyring the set was made against not compared                             | service                                                |
| V5  | the save written while locked                                                 | service                                                |

In the first follow-up round, N7d (rule 3's first form) survived once: its test made every write fail after the save,
the reminder's too; it now fails only the vault's (U3 is that test).

## 9. Deviations from the proposal

1. **No Python reference and no `shares` group in `contract/vectors`** (§3.3). The task kept the contract unchanged; the
   arithmetic is checked against SLIP-39's own vectors and its reference instead (§2). A `contract/py` port is a follow-up,
   before release (it is what lets the open format be read without the extension, §3.4).
2. **No pinned `shamir-mnemonic` development dependency** (§3.3): "no new dependencies". The reference is run once,
   outside the tree, to make the fixtures; their generator is in the tree.
3. **"Split my current code" needs the code, not the master password** (§3.7 says the wizard needs the master password):
   the code itself resets the master password, so asking for both adds a step and no protection. "Replace" asks for the
   master password, as a new recovery key does. A split is recorded (`shares_made`).
4. **"Check my shares" records nothing** even when the shares are stale (the proposal: "It writes nothing"); it needs an
   unlocked vault instead (§3). It writes one thing: it drops the reminder when the shares pass after the restart. A
   stale set typed on the lock screen is recorded as a wrong recovery key, as a typed one.
5. **No yearly reminder** (§3.6, "offered, off by default"); instead the reminder from the next browser start until a
   check passes (§4), which closes the rollback residual and needs no schedule.
6. **The check bits are a CRC-20**, not 20 bits of SHA-256 (§3.3): detection of every single substitution, every swap of
   neighbours and every pair of substitutions is guaranteed rather than likely (§2).
7. **The name**: "Recovery key shares" / 恢复密钥分片, the proposal's name and, since OWNER-DECISIONS/16 question C (2026-10-23), the
   site's word; until then "Recovery code shares" / 恢复码分片 (the earlier name). The proposal's `sharesTitle` ("Split
   your recovery key") is the fold's `sharesFoldTitle`.
8. **The test restore is also asked for "split"** (the proposal lists it in the flow for both): it catches a copying mistake
   while the paper is at hand; it writes nothing.
9. **With sync on, the shares fold is not offered**: Password & recovery then shows only the box that points to the Sync
   section (as for every key change). "Replace" is refused there anyway (`sync_on`); "split" and "Check my shares" would
   work and could be offered once the Sync section manages the recovery key itself. The lock screen's and the reset's
   "I have shares instead" work with sync on (they only rebuild the code). Sync is behind the release gate.
10. **The stale message never says "destroy them"** (§3.7's `sharesStale` did): shares that do not open this vault may be
    another vault's (§3.5 says so itself).

## 10. Questions for the owner

1. **Naming**: decided 2026-10-23 (OWNER-DECISIONS/16 question C, (a)): "恢复密钥 / Recovery key" everywhere, the shares
   "恢复密钥分片 / Recovery key shares"; until then "恢复码分片 / Recovery code shares" (the earlier name), as the rest of the page said
   "恢复码". Done in one patch: `scripts/i18n/recoverykey.py` and the fragments that held the old word, `shares.py` among them.
2. Decided 2026-10-23: the lazy catalog stays outside the 12 KB aggregate; the page with it is held to 15,360 B (§6).
3. Decided 2026-10-23: the MIT fixture stays (`shares-slip39.json` only; `LICENSES/MIT.txt`, REUSE.toml, LICENSE.md and
   RELEASING-THE-TREE.md say so); the Sixkey-chosen cross-check is in a file of its own under the extension's licence.
4. Decided 2026-10-23: no yearly reminder; the reminder from the next browser start until a check passes is built (§4).
5. Agreed: 2 of 3 and 3 of 5 only; the format allows up to 16.

## 11. Real-browser checks

Owner checklist item 29 (revised for revision 2: the done screen, a paper of another set at the test, the reminder after
a restart, the stale wording, the name; and for the follow-up: a check before the restart, the reminder at every unlock
until a check passes, the settings page that unlocks first).

## 12. Revision 2: the review's findings

| Finding                                                                                             | Done                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: the done screen said to destroy the old code at once                                            | it says to keep it until "Check my shares" passes after the next browser restart; the reminder from the next start until a check passes (§4); local-vault.md and checklist item 29 aligned                             |
| F2: a paper of another set at the test restore was "could not read its data"                        | the entry is bound to the set at the test and refuses another set's share as it is typed; the switch's errors in the shares' words, mapped in the wizard for `key-ops.ts` (not in `ui/errors.ts`): no diagnostics line |
| F3: "belong to an old recovery code ... destroy them" (earlier name) for another vault's shares too | "may belong to an older recovery code, or to another Sixkey vault (set …)"; no screen says to destroy shares                                                                                                           |
| F4: split's done screen said the old shares stop working                                            | split's done screen says the recovery code paper still works; "Lost a share?" names "Make a new recovery code" (earlier name)                                                                                          |
| F5: the done screen kept the whole set                                                              | it keeps the mode, the threshold, the count (a rule test)                                                                                                                                                              |
| F6: the check caught a typo with probability 1 − 2⁻²⁰                                               | a CRC-20 that guarantees every single substitution, every swap of neighbours and every pair of substitutions (§2), proved by exhaustive and structural tests                                                           |
| F7: 8 of the 12 invalid vectors were refused by the test's own helper                               | the member level goes through Sixkey's `combineShares`; 8 apply and are refused by it, 4 are group-level only and do not apply (§2)                                                                                    |
| F8: the release checklist's licence list; the generator said to be MIT                              | MIT added to RELEASING-THE-TREE.md (one fixture, never shipped); only the JSON of official vectors is MIT; the cross-check moved to `shares-cross.json` under the extension's licence                                  |
| F9: a split left no trace                                                                           | `shares_made` in the security record                                                                                                                                                                                   |
| F10: the proposal's header contradicted itself                                                      | the second line now covers Features A and C only                                                                                                                                                                       |
| F11: the Sync section's fields do not pass `stale`                                                  | left, noted in §5 (behind the release gate)                                                                                                                                                                            |
| F12: no `contract/py` port                                                                          | §9 item 1, a follow-up before release                                                                                                                                                                                  |
| F13: the test restore can be typed from the screen                                                  | a design note: it proves the shares can be typed, not that a paper exists; the person's choice, the master password remains                                                                                            |
| F14: R1, R4, R5, R6 survived                                                                        | tests for each; all four now killed (§8.2)                                                                                                                                                                             |
| Naming (OWNER-DECISIONS/16 C pending)                                                               | "恢复码分片 / Recovery code shares" in the fold, the paper and every text (the earlier name; renamed "恢复密钥分片 / Recovery key shares" on 2026-10-23, §10)                                                          |
| Budget (owner question 2, decided)                                                                  | lazy catalog outside 12,288; the page with it at most 15,360 B, enforced and tested; every part has about 194 B left                                                                                                   |

## 13. Follow-up (SHAMIR-FU): the review's r2.7 and FU findings

| Finding                                                                                       | Done                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1: a check that passed before the restart dropped the reminder                               | `SecurityLog.checked`: a pass drops only a due reminder; before the restart the check says "current_before_restart" and the wizard asks for one more check after the restart (the reviewer's repro is the first N1 test)                                                                                                                                        |
| N2: a new vault left a reminder that could never go                                           | `makeVault` (a first vault, a backup restored, Start over) drops it; the record's entries stay                                                                                                                                                                                                                                                                  |
| N3: B3 survived (a fake `KeyOps`)                                                             | a test through the real `useKeyOps` with the wizard's `sharesWords`                                                                                                                                                                                                                                                                                             |
| N4: "once"                                                                                    | the reminder shows after every unlock until a check passes: the notes, local-vault.md, the checklist, the comments and the test names say so                                                                                                                                                                                                                    |
| N5: from the reminder to a page that unlocks first, the fold stayed closed                    | `#shares` is kept until the fold has been open unlocked: it opens at that unlock, once                                                                                                                                                                                                                                                                          |
| N6: log names                                                                                 | the follow-up's logs are `fu-*`                                                                                                                                                                                                                                                                                                                                 |
| N7: the reminder was the switch's last write                                                  | written before the save (§3, §4), after the save's conditions are checked once, so a switch refused before the save writes nothing; put back as it was when the save is refused; the crash test holds the order at every write, and a reminder left by a switch that did not land makes its check say so ("stale_after_switch")                                 |
| FU-1: under two pages at once, a refused switch's put-back could drop a reminder still needed | `unremind`'s four rules (§3): nothing when the reminder was not known to be written; kept when the keys cannot be read or the save landed; else put back under the security record's own lock only while it is still this switch's (a random id, as two switches can share a millisecond). The reviewer's two races are tests; mutants for each rule and the id |
| FU-2: "that switch did not complete" for shares of any set                                    | the reminder holds the switched set's id (printed on every share; local-vault.md and PRIVACY.md say so); the wizard passes the typed set's id; only that set's shares get the line                                                                                                                                                                              |
| FU-3: keys adopted through sync do not end a reminder                                         | noted (§4), behind the release gate                                                                                                                                                                                                                                                                                                                             |
| FU-4: a reminder that cannot be written does not hold the switch back                         | noted (§4): intended                                                                                                                                                                                                                                                                                                                                            |
