# CLOUDBK notes: the one-click cloud backup, patches 1–6

> **Superseded, 2026-11-08.** The Google Drive backup through a plugin is withdrawn, and the backup in Chrome sync
> replaces it: see [CSB-NOTES.md](CSB-NOTES.md). These notes record the Drive path as it was built; its code was removed
> in CSB-R (CSB-NOTES.md §16). The file format, the restore and the status it made are still used.

> **2026-11-02: since 42903a1, Google's half is the official cloud plugin's.** What these notes say of the store build's
> `identity`, its `oauth2` key, its CSP's Google origins and its worker's Google transport (§6, §7, §8) describes the
> builds before that commit: those parts are now the separate Sixkey Cloud Backup extension's, and the store build's
> worker talks to it (`src/platform/cloud-provider.ts`). The rest (the file, the rules, the status, the pages) holds.
> [CLOUD-PLUGIN-NOTES.md](CLOUD-PLUGIN-NOTES.md) records the split, its review and the follow-up.

> **2026-11-06: from CSB-0 on, the store build hides the cloud backup.** CSB is the encrypted backup in Chrome's sync
> storage, being built into the extension; CSB-0 is its first patch. The Drive backup through the plugin, which is not
> to be published, is withdrawn from the store build (the maintainers' C8): `scripts/google-oauth.mjs` `cloudUiIn` is
> false there. It shows none of the pages below (the card, the restore from Google Drive in Settings › Backup and in
> first run, first run's offer, the popup's pill and one click), ships none of the four page chunks (`scripts/build.mjs`
> drops the settings page's three; the card's logic, `act`, `cloud-go` and `cloud-provider`, and the cloud text stay in
> the settings page's code, used only to open a cloud backup file), not the plugin's store page, and trusts no cloud
> plugin (its catalog without the cloud entry, as the ID draft's: `externally_connectable` is the reserved ID alone). Its
> backup is the encrypted file in Settings › Backup, which the popup's own 立即备份 opens; a downloaded cloud backup file
> still opens there and restores through first run. The e2e and developer builds keep the pages.
> `extension/scripts/package.mjs`'s `providerGate` still refuses a store package while the plugin's ID is the
> local-development one, though nothing it protected is left in the store build: it has to go before the first store
> package (in CSB-R, which removes the plugin path, or a small patch before it).
> The three browser specs that ran the store build beside the plugin (`cloud-plugin`, `cloud-provider`,
> `cloud-card-visual`) are skipped there. With them went the only browser coverage of Sixkey and the plugin over real
> extension messaging, of the card in the plugin's states (the visual guard's probes), and of the plugin's manifest's
> install warnings: until CSB-3 unwires the plugin path, the developer build's plugin path has unit tests only.

The design is [CLOUD-BACKUP.md](../proposals/CLOUD-BACKUP.md) (approved direction, OWNER-DECISIONS/21, 2026-10-31). These
notes record what was built, how it is tested, the mutants that check the tests, and the sizes. Patches 1 and 2 are
imported by no entry point, so no build carries them (check-dist's numbers are unchanged, §4); they are in revision 3
(r3), after two independent reviews. Patch 3 adds the Google sign-in and the network transport, used in the dev build
only, by its developer cloud page; the prod and e2e builds' output is byte for byte what it was (§5.8); it is in
revision 2 (P3-r2), after a review. Patch 4 wires the backup into the service worker (§6): the store build's worker
uploads to Google Drive once a page has connected it (no page does yet: patch 5's card), its manifest offers `identity`
and its CSP names Google's two API origins; the e2e build's worker backs up to an in-extension fake Drive. Patch 5 adds
the settings pages (§7): Settings › Backup's Google Drive card, the restore from Google Drive, first run's offer and
"选择文件" opening a cloud backup, with the review of patch 4's suggestions A1 to A7. Patch 6 (§8) adds the popup's and
the side panel's pill and footer, and the one click from the popup. §0 maps each point of the reviews,
and each item of patch 4's specification, to what changed and the tests that hold it; §7.1 does the same for patch 5,
and §7.8 to §7.11 for the reviews of patches 5 and 6 (REVIEW-P5P6.md, -r2, -r3, -r4), with §8.5 for the popup's point.

## 0. The reviews: each point, what changed, and the tests

The review (2026-10-31) found CB-01 to CB-14; the maintainers decided each. A second review (round 2) found R2-01 to
R2-05 in patches 1 and 2, and P3-01 to P3-04 in patch 3; r3 follows the maintainers' decisions on them (the rows after
CB-14). A third review (REVIEW-r3, of r3 and P3-r2) found them mergeable and made six suggestions, S1 to S6, which patch
4 follows (the rows S1 to S6); the rows P4-1 to P4-8 are patch 4's specification (CLOUD-BACKUP §8 and the maintainers'
brief). §1 is patch 1, §2 patch 2, §5 patch 3, §6 patch 4.

| # | The decision | What changed | Tests |
|---|---|---|---|
| CB-01 (high) | The free backup is the latest copy only. After every upload, delete the file's older revisions; at a wrap or purge event, also this device's own earlier files. Never another device's file. Say honestly what a downloaded copy keeps; option c best before the first upload | `rules.ts`: `wrapsOf` and `CloudLink.wraps` (a new wrap is a change, rule 6), `pruneEvent`, `ownAfter` and `CloudLink.own`, `revisionsToDelete`, `ownFilesToDelete`; the header's rule "never deletes another device's file; keeps only the latest version of its own". `format.ts`'s and §1.1's wording ("has nothing to guess" now says what it covers). CLOUD-BACKUP §0.2, §1.2 (c), §1.5, §3.2, §3.3, §6.3, §7.2 step 4, §10 R11–R12, §11 item 16. Patch 2: `runBackup` compares the uploaded wraps, deletes the older revisions after every upload and, at an event (`purged` for an erased account), the earlier files the caller merged, and reports `pruned`; a failed deletion keeps the new link. `Drive.revisions`, `deleteRevision`, `deleteFile`; the fake's revisions, Keep forever and deletes | `cloudbk-rules.test.ts`: "what a device deletes of its own (review r2, CB-01)" (5 tests), the rewrap rows of decideWrite, the wraps cases of parseCloudLink, and the model (a rewrap action; after every upload the file holds one revision; after a prune event no merged earlier file is left), with two checks that it is not vacuous. `cloudbk-remote.test.ts`: "the latest copy only (CB-01)" (the reviewer's three Drive-history probes, now with nothing left to open; under the recovery key only a password change uploads nothing; Keep forever; a failed deletion) and "what a device deletes of its own at a wrap event (CB-01)" (4 tests); the property's "one revision after every upload". `cloudbk-drive.test.ts`: "lists a file's revisions, deletes one for good, and deletes a file for good, the trash skipped (CB-01)", "reads a file's revisions over several pages" |
| CB-02 | Group by vault, mergeVaults inside, addAccountsFrom between, the newest file's vault the base; a two-vault property; make "any order" real | `restore.ts` step 3 | `cloudbk-restore.test.ts`: "several vaults (CB-02)" › "merges each vault first, …whichever vault is newest" and "the newest file's vault is the base; …"; properties › "Drive's times decide the base, never the content: …" (random times, three files) and "two vaults: whichever file is newest, …" |
| CB-03 | Never accept a secret older than the newest of its method among the opened same-key files; a password restore stays one step and says so; a recovery restore is the reset | `restore.ts` step 4: `newestWraps` by `createdAt`, `outdated`, `needsPassword`, the recovery wrap alone after a recovery restore; CLOUD-BACKUP §3.6 step 5 rewritten | "the restored keyring (CB-03)": the reviewer's two scenarios ("a password restore takes the recovery key renewed on another computer, …", "a recovery-key restore keeps no password wrap at all: …"), "a password older than another computer's restores, says so, …", "takes the keys from the newest file opened, never a wrap of another vault key, …" |
| CB-04 | Pages with `nextPageToken` up to 200, "N files not read" | `drive.ts` `list()`: pages of 100 up to `MAX_LISTED` (200), then the rest counted by id up to `MAX_COUNTED`; `fetchBackups` returns `notRead`; CLOUD-BACKUP §3.6 step 1 and §6.3 ("还有 $1 份备份没有读取") | drive: "lists page after page up to MAX_LISTED, newest first, and counts the ones it did not read (CB-04)", "counts at most MAX_COUNTED files it did not read"; remote: "a restore past the first page (CB-04)" (the reviewer's 21 files, all restored; 203 files, 3 unread) |
| CB-05 | Correct the wording | `rules.ts` header, §1.2 below, CLOUD-BACKUP §3.3 rule 7 and §10 R6: the one overwritten forks at its next upload **that has a change**; until then its last upload is on its own disk only | the model holds "nothing uploaded is lost" for atomic uploads only, as it says; remote: "the race, as it is (CB-05)" (the reviewer's probe: with no change since, the one overwritten does not fork; its next change does, and a restore then has both) |
| CB-06 | Try the held vault key on same-key forks with older wraps | `restore.ts` steps 1–2: `byVk`, a second lookup beside the per-wrap cache (which stays keyed by the wrap) | "opens a fork whose wrap the password no longer fits with the vault key in hand (CB-06)"; "a password older than another computer's restores, …" (the newest file's wrap fails, the vault key from the older one opens it) |
| CB-07 | The 403 reasons per Drive's docs | `drive.ts` `errorOf`: `quota` only for storageQuotaExceeded; dailyLimitExceeded among the rate limits, and any reason of the domain `usageLimits`; the fake sends a domain | drive: "403 %s (%s) is the code Drive's error page implies (CB-07)" (13 rows), and the 403 rows of the status table |
| CB-08 | `too_large` and `forbidden` get a home in the status | `status.ts`: two more `CloudError`s, both stopping. Patch 2: `remote.ts` `cloudErrorOf`, the status of every Drive code and every refusal of the file | `cloudbk-status.test.ts`: the rows "a vault too large for one upload" and "Google refuses the app"; remote: "the status of every failure (CB-08)" (every `DriveErrorCode`, every `CloudBackupError`, anything else) |
| CB-09 | Refuse KDF parameters outside kdf.ts's range before deriving; bound a restore's work | `format.ts`: PBKDF2 iterations outside `PBKDF2_MIN_ITERATIONS`..`PBKDF2_MAX_ITERATIONS` are `invalid_file`; `restore.ts`: `MAX_RESTORE_ITERATIONS` (40M: twenty derivations at today's 2M), a file past it skipped as `limit` | format: the refusals "a password wrap below PBKDF2's floor (CB-09: …)" (599,999) and "a password wrap above the ceiling" (20,000,001); restore: "the work a restore does (CB-09)" › "derives within its budget, and skips a file past it as 'limit'" (PBKDF2 calls counted) |
| CB-10 | One wording for the cost example | CLOUD-BACKUP §0.2, §1.3 (twice), §1.4; `OWN-PASSWORD-NOTES.md` (two places) and `docs/security/local-vault.md`: the example is "a memorable password of about 34 bits" throughout | (docs) |
| CB-11 | The doc mismatches | CLOUD-BACKUP §1.2 (the example's fields), §3.6 step 4 (across vaults), §1.3 (a re-uploaded own file, `modifiedTime`), §3.4 (`sk_cloud_cfg` holds the `CloudLink`), §8 (rules 1–8), §3.5 (multipart [verified], no resumable), §3.3 and §10 (CB-05) | (docs) |
| CB-12 | Close the test gaps behind V4, V5, V9, V11, V12, V13, V16, V19 | V5: the size cap tested with valid JSON, and in UTF-8 bytes; V9: `adoptLink` compared whole; V11: a far-future fork that is not the newest file; V12: an account in the base vault's trash; V13: the newest file's wrap fails and the same key's older wrap is still tried; V4 has no target (no `previous` is uploaded, CB-13). V16: a file rewritten between the restore's listing and its download. V19: the fake answers only the fields asked for, and Drive's short default when none | format: "refuses text that is not JSON, and valid JSON larger than any vault, for its size (CB-12)"; rules: "a link after an upload or a restore continues the file at this store's counter, …"; restore: "clamps every file's timestamps, not only the newest's (CB-12)", "does not bring back as new an account that sits in the base vault's trash (CB-12)", "a password older than another computer's restores, …"; remote: "the head a restore keeps (CB-12, V16)"; drive: "asks for every field it reads: the fake, like Drive, answers only those (CB-12, V19)" |
| CB-13 | Upload `previous` only if restore needs it | It does not: an envelope is always under the current vault key (`checkGeneration`), and `restore.ts` never read it. `makeCloudBackup` uploads `previous: []`, the parser refuses a non-empty one, and the restored keyring has none. Uploaded, the earlier keys would open older copies (a recovery-only copy, a copy under another password) that their own wraps do not | format: "leaves the earlier vault keys out (review r2 CB-13): …" and the refusal "an earlier vault key" |
| CB-14 | Wrap the token provider's errors | `drive.ts` `call()`: the token provider's own `DriveError` as a new one, anything else `no_token` with nothing of what it said; `cloudErrorOf` makes `no_token` "reconnect" | drive: "a token provider's failure carries nothing of it, and nothing is sent (CB-14)" |
| R2-01 | Describe the CB-10 change neutrally | the CB-10 row above: no quotation of what was removed, and no word of whose password it was | (docs) |
| R2-02 | Keep the cleanup duty in the link until it is done; do it in every run while it is owed, also one that uploads nothing; a worker-only event waits for a page's `merged` | `rules.ts`: `CloudLink.pruneDue` and `filesDue`, `linkAfter(…, dues)`, `withDues`, parsed strictly. Patch 2: `runBackup` hands the new link, owing its cleanup, to `persist` before any deletion, does what a link owes in every run (also a skip), and leaves the earlier files to a run with `merged`. CLOUD-BACKUP §3.2 ("the next run", not "the next upload"), §3.3, §3.4 | rules: "a link carries the cleanup it still owes, and gives it up only when told (review r3, R2-02)", and the read-back and parse cases of the two flags. remote: "the cleanup a link owes, until it is done (review r3, R2-02)" (5 tests: the reviewer's two probes fixed, a worker stopped in its deletions, a file left behind while owed, a deleted file's owed cleanup) and "an earlier file that fails to delete is remembered, and deleted by the next run that has the merge" |
| R2-03 | The restore base is the newest key, by the newest wrap's `createdAt`, not Drive's time; say when files under another key of the vault were opened | `restore.ts` step 4: `newestKey` within the base vault, `base` the newest file under it, `olderKeys`; CLOUD-BACKUP §1.5 (with sync off a rotation reaches only the computer that made it), §3.6 steps 5 and 6, §6.3 ("restored, older key") | restore: "with sync off, the computer that kept the retired key wrote last: the restore still lands on the rotated key" (the reviewer's probe, fixed), "takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03)" |
| R2-04 | A password restore keeps the password wrap the typed password opened; `outdated` when one dated later exists; patch 5 offers a new master password there, skippable; a recovery-key restore stays the reset | `restore.ts` step 4: the newest wrap the typed password opened, `outdated` by date, `password` the spelling that opened it; CLOUD-BACKUP §3.6 step 5, §6.3 ("restored, older password"), §8 patch 5 | restore: "a password older than another computer's restores, says so, and the restored keyring keeps it (R2-04)", "a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept" (the reviewer's probe, fixed) |
| R2-05 | Revision ids of Drive's id alphabet; an exact method × path allowlist in the transport | `rules.ts` `REVISION_RE` = `[A-Za-z0-9_-]{1,200}`, for the link's head and the earlier files' heads. `drive.ts`: revision ids of the same alphabet, refused before they go in a path; file ids never Drive's words (`trash`, `generateIds`). The transport's allowlist is patch 3's | rules: "a head that is a path's dot-dot (R2-05)", "an earlier file's head with a dot"; drive: "refuses an id that is not Drive's, before sending anything" ("..", ".", "a.b", "trash", …), "a revisions answer that cannot be read is bad_response: a revision id that is a path's dot-dot (R2-05)" |
| Deviation 3 | Say that a file in the trash keeps its wraps up to 30 days | CLOUD-BACKUP §1.5, §3.3, §10 R11; the `rules.ts` header | (docs) |
| P3-04, Q12 | A test that counts a generated-shape password's second spelling | (a test only) | restore: "counts a generated-shape password's second spelling in the budget" |
| R2-05, the transport | An exact method × path allowlist in the transport | `google-transport.ts`: `ENDPOINTS` (the nine endpoints `drive.ts` calls, each with its method; ids of Drive's alphabet, never `trash` or `generateIds`), `allowed`; CLOUD-BACKUP §2.5 | transport: "refuses %s %s (%s): only the endpoints the backup calls (R2-05)" (11 cases: emptying the trash, sharing, a folded dot-dot, a metadata patch, …), "takes each endpoint the backup calls, with its one method" |
| P3-01 | Pin the Google account: record it at connect, check it before every upload (another account: stop, "reconnect", write nothing), `login_hint` on the silent renewal; the call sites in patch 4's spec if they need its wiring | `drive.ts` `about()` also gives `permissionId` (`user(emailAddress,permissionId)`: no scope beyond `drive.file`; tokeninfo would need the token in a URL, userinfo the `openid`/`email` scope); `remote.ts` `pinAccount`, `runBackup`'s `account` → `wrong_account` before anything is read or written, `cloudErrorOf` → reconnect; `google-auth.ts` `hint` → `login_hint`; the fake Drive's accounts; the dev page's step 5 names the account. The call sites (record at connect, pass to every run, `hint` from `sk_cloud_cfg.account`) are patch 4's: CLOUD-BACKUP §2.1, §2.2, §8 | remote: "the account a backup is pinned to (review r3, P3-01)" (2 tests), the status row "Drive's wrong_account is reconnect"; drive: "names the account, with Drive's own id for it (the account pin, P3-01)", "each Google account sees only its own files; …"; auth: "the silent renewal names the account recorded at connect (login_hint), and only the renewal (P3-01)"; devcloud: the silent check naming the account |
| P3-02 | Disconnect revokes every token still held, whatever its remaining lifetime | `google-auth.ts`: `heldToken` (any stored token of the right shape) instead of the renewal margin's `liveToken` | auth: "disconnect revokes a web token whatever is left of its lifetime, minutes or none (P3-02)" (4 min, 1 s, expired) |
| P3-03 | One instruction: the dev client in a Cloud project of its own; the dev page's files apart, ignored by restore | CLOUD-BACKUP §7.1 step 1 ("Sixkey dev"), §7.2, §3.6 step 2; `scripts/google-oauth.mjs`; `drive.ts` `FileKind`, `create({kind})`, `list(kind)`; the dev page's files carry `sixkey: "devcheck"`, and the page lists only those | devcloud: "the page's files are its own: no restore lists them, and the page lists no backup (P3-03)"; drive: "each Google account sees only its own files; the developer page's files are listed apart (P3-01, P3-03)" |
| P3-04 | Tests that kill Q12, Q14 and Q20; Q21 is equivalent | (tests) | Q12: patch 1's row above; Q14: auth "refuses another path at the extension's own redirect origin (Q14), and keeps nothing"; Q20: auth "each flow's state is new, from the random source, and an answer must carry that one (Q20)". Q21 (the transport not checking the port) is equivalent: `driveUrl` keeps a URL only when its parsed `href` starts with one of Drive's roots, which no URL with a port other than the default does, and the URL parser drops the default port, 443 |
| S1 | `merged: []` must not end the duty for an earlier file of the same vault: record the vault in each earlier file; only other vaults' files may be let go once a page has looked | `rules.ts`: `OwnFile` is `{id, head, vaultId}` (`ownAfter` records `link.vaultId`; the parser requires it, so a link of r3 with earlier files reads as none: a new file, which overwrites nothing); `remote.ts` `pruneOwn`: `filesDue` stays while an earlier file of the uploaded vault is left, merged list or not; a page's merged list carries the vault (`cloud-config.ts` `parseMerged`) | rules: "a fork that leaves its own file records the vault it held (review r3, S1)", the parse case "an earlier file without its vault (S1)"; remote: "an earlier file of another vault is let go once a page has looked; one of this vault never is (S1)" and the R2-02 test's `merged: []` row; the reviewer's probe "now: `merged: []` at an event …" fails on P4 (§6.8). Mutant X4 |
| S2 | Bind `merged` to the generation merged into; a stale list after a fallback deletes nothing | `remote.ts`: `MergedList = {seq, rev, files}`, `mergedFor`: the list counts only when `seq` and the envelope's `rev` are the uploaded generation's and the link carries no recovery mark; otherwise it is no list (nothing deleted, the duty kept). The worker keeps a page's list (`sk-cloud-merged`) for the runs of that generation, and drops it once a run of that generation or a later one went through. CLOUD-BACKUP §3.3, §8 patch 5 | remote: "a merged list counts only for the generation it was merged into, never after a store fallback (S2)" (the reviewer's probe: the account the file alone has survives a restore) and "the binding itself: …" (seq, rev and the mark, each alone); worker: "is kept for its generation and consumed by …", "a list is not consumed by a run that failed", "a list that does not check out is refused". Mutants X1–X3, M1, M2 |
| S3 | Do not lose the revision duty when an overwrite's answer is lost, or in a fork from another writer's head whose deletion fails again; otherwise document Drive's ~30-day bound | `remote.ts`: before an overwrite the link is saved with `pending`, the sha-256 of the text sent; a later run that finds another head downloads it and, if it is that text, takes it as its own (the revisions' duty then done) instead of forking. `rules.ts` `prunes` (at most `MAX_PRUNES`, 20): a fork that leaves a file whose revisions are still owed keeps that duty, done first by every run until it succeeds. The worker runs once more before turning the backup off. What still loses a duty (a link that no longer parses, a restore in place, off while Drive refuses) is written down with Drive's bound: CLOUD-BACKUP §3.3 | remote: "an overwrite whose answer is lost is recognised as this device's own next time, and its cleanup done (S3)", "a head that is not the overwrite's own text is another writer's, though one was in flight (S3)", "a file left behind while its older revisions were still owed keeps that duty, …", "a fork from another writer's head while its file's revisions are still owed keeps that duty (S3)"; rules: "a link keeps other files' owed deletions, at most MAX_PRUNES, …"; worker: "the link is saved after the upload and before any deletion, and an overwrite names its text first", "turning backup off uploads what waits first". Mutants X5–X8, X12, M4, M5. The reviewer's lost-answer probe still forks: its harness passes no `persist`, and without one nothing can be saved before the request (§6.8) |
| S4 | Upload the retired key ids, ids only; a restore never picks a retired key | `format.ts`: the container's `retired`, the ids of the keyring's `previous` keys (at most 64, unique, hex, never the file's own key), nothing else of them; parsed strictly. `restore.ts` `newestKey`: a key that any opened file names as retired is never the newest, unless every key is so named | format: "leaves the earlier vault keys out (review r2 CB-13): …" (their ids, and nothing else of them, in `retired`) and the refusal "no list of retired keys (S4)"; restore: "never lands on a key another file names as retired, though the computer that kept it changed its password later (S4)" (the reviewer's probe). Mutants X9, X10 |
| S5 | Docs: `permissionId`'s stability [inferred]; `emailAddress` may be missing; Chrome-path `wrong_account` must offer two ways: reconnect the recorded account through the account chooser, or move the backup to the new account. Patch 5's UI specified, the core here | CLOUD-BACKUP §2.1 (the User resource read, 2026-10-31: `emailAddress` "may not be present in certain contexts …", `permissionId` "The user's ID as visible in Permission resources"), §11 item 3, §5.5 below. `cloud-worker.ts`: a run stopped by another account's token records that account as `mismatch`, never switches; `connected(via)` refuses another account than the recorded one the same way; `switchAccount` moves the backup (that account recorded, no link: a new file in its Drive; the old account's files left). The pin holds `email: null` when Drive gives none | worker: "every run checks it: a token of another account reads and writes nothing, stops as reconnect, and says which account it was", "the first way: …", "connect with another account when one is recorded changes nothing but the mismatch", "the second way: …", "an account whose address Drive leaves out is recorded by its id alone, and checked by it"; e2e: "a token of another Google account stops the upload …". Mutants A1–A4 |
| S6 | A test that kills M8: `pruneDue` kept on skip runs | (a test) | remote: "an owed deletion that fails again in a run that uploads nothing stays owed (S6)". Mutant X11 (M8 on the new `withDues`) |
| P4-1 | The real fetch transport in the store build; the source rule becomes "fetch in exactly the allowed places" | `platform/cloud-google.ts`: the worker's Google sessions over one `GoogleTransport`, the sign-in built per session (`chrome.identity` appears only once the permission is granted, after the worker started). `test/unit/m5-source-rules.test.ts`: `fetch` once in each transport and nowhere else; `GoogleTransport` built in `cloud-google.ts` and the dev page's worker end only; `cloud-google` and `cloud-fake` imported by the worker alone; no `fetch` in the fake | m5-source-rules (the rule); wiring: "the sign-in is built per session: a permission granted after the worker started is seen by the next run". Mutants S3, S4, G1, G2 |
| P4-2 | Manifest: `identity` optional, the `oauth2` block, CSP connect-src for Google's endpoints; check-dist allows exactly those origins | `manifest.base.json`: `identity` optional, the CSP with `https://www.googleapis.com https://oauth2.googleapis.com`; `manifest.e2e.json` and `scripts/build.mjs`: the e2e build without either; `oauth2` per Google build once `google-oauth.mjs` names its Chrome client (none yet, so the store build has none). `check-dist.mjs`: `GOOGLE` (store and dev), the exact CSP, `identity` optional where Google is and never required, `GOOGLE_URLS` the only Google URLs, `fetch` twice in a Google build's worker and once in the e2e one's, the fake's mark only in the e2e worker, no Google origin, `identity` or token record in any e2e file; the worker's size held (112 KB gz) | `cloudbk-check-dist.test.ts` (24 tests: the pristine builds, 14 store-build alterations, 7 e2e ones); m5-check-dist's fetch cases. Mutants B1–B9 |
| P4-3 | `sk_cloud_cfg`, with `persist` wired to the link | `platform/cloud-config.ts` (both records, read strictly: a record that does not check out is backup off, no link); the worker's `persist` saves each link `runBackup` hands it, under the records' lock, keeping a recovery mark set meanwhile; `platform/cloud-mark.ts`: the store's recovery hook marks the link in every context (`runtime-base.ts`) | wiring: the records and the mark; worker: "the link is saved after the upload and before any deletion …", "a load that recovered an older copy marks the link first …", "a mark set while an upload is in flight is kept". Mutants K1–K5, M4, M6, M7 |
| P4-4 | The worker: a 30 s debounce after a vault change, retries with backoff, a daily check, upload without unlocking | `platform/cloud-worker.ts`: `watchVault` (a write of `sk_active`, from any context), `sk-cloud-soon` re-armed 30 s ahead (5 s in the e2e build), `sk-cloud-retry` after 1, 5 and 30 minutes, an error no retry fixes waits, the six-hourly routine's daily check and lost-alarm check, one run at a time; the run uploads `VaultStore.load()`'s generation, which needs no key | worker: "when it runs" (4), "retries" (4), "the daily check" (3), "what a run uploads" (6), "in the real worker" (2); e2e: "a change of the vault uploads after the debounce, not before", "a locked vault is uploaded all the same". Mutants D1–D8, R1–R6, C1–C3 |
| P4-5 | The account pin's call sites: record at connect, check on every run | `connected(via)` records `pinAccount` (the page signed in; the worker asks `about.get` itself); every run passes `account` to `runBackup`; the web path's silent renewal names the recorded address (`googleSessions`' `hint`) | worker: "the account" (7); e2e: the wrong account. Mutants A1–A4 |
| P4-6 | An in-extension fake Drive for the e2e build: nothing touches the network in e2e | `platform/cloud-fake.ts`: Drive's requests answered from one storage.local record, at `sixkey-fake-drive://drive`, with accounts, revisions and the head's protection; `__CLOUD_FAKE__` and `__DRIVE_ORIGIN__` (`scripts/build.mjs`) put it, and no Google code, in the e2e build | wiring: "answers the whole path as Drive does …", "another account sees none of the first's files …", "refuses what Drive refuses …"; check-dist: the e2e build has no Google origin. Mutants F1–F3, B9 |
| P4-7 | PRIVACY.md and ARCHITECTURE.md §2–§4 for the new destination, in the same patch | PRIVACY.md: the short version, the new records, a section on the backup to the user's Drive (what, where, what Sixkey sees, what Google sees, when, what it deletes), the "does not do" list's network item; ARCHITECTURE §1, §2.1, §2.2, §3, §4 and §7 | (docs) |
| P4-8 | The worker's messages | `sender-policy.ts`: six `sk-cloud-*` rows, from the settings page alone; `sw.ts`: their own table and listener, answered after the work; `options/Misc.tsx`: "delete forever" sends `sk-cloud-purged` | autofill-pre-sender (the rows, each type's work once, refusals, the open channel), autofill-pre-source-rules (the tables, the listeners, the gate). Mutants S1, S2 |

**One deviation from the letter, kept narrow.** "Delete all non-head revisions" is implemented as "every revision older
than the one just written" (`revisionsToDelete`): the head at the moment of deleting may already be a racing writer's
newer revision, and deleting that would put its data out of every head. Revisions written after Sixkey's own are left
to that writer, whose own upload deletes them. In the model, and whenever nobody races, the two are the same.

## 1. Patch 1: the pure logic (`src/core/cloud/`)

### 1.1 The file (`format.ts`)

```json
{
  "format": "sixkey-cloud-backup",
  "v": 1,
  "app": "Sixkey 0.2.0",
  "opens": "both",
  "retired": [],
  "generation": {
    "v": 1, "seq": 41, "savedAt": 1793379341960,
    "envelope": { "format": "sixkey-vault", "formatVersion": 1, "cipher": "AES-256-GCM", "vaultId": "…", "vkId": "…",
                  "rev": 41, "iv": "…", "ciphertext": "…", "checksum": "…" },
    "keyring": { "format": "sixkey-keyring", "v": 1, "vaultId": "…", "vkId": "…",
                 "wraps": [ { "method": "password", "vkId": "…", "kdf": { "name": "PBKDF2", "hash": "SHA-256",
                              "iterations": 2000000, "salt": "…", "v": 1 }, "iv": "…", "wrapped": "…", "createdAt": 0 },
                            { "method": "recovery", "vkId": "…", "kdf": { "name": "HKDF", "hash": "SHA-256", "salt": "…",
                              "v": 1 }, "iv": "…", "wrapped": "…", "createdAt": 0 } ],
                 "previous": [] }
  }
}
```

- **Made from the disk with no key.** `makeCloudBackup(gen, opens, app)` takes one `Generation` as `VaultStore.load()`
  returns it (no vault key needed: the store judges integrity by the checksum), checks it with the store's
  `checkGeneration`, and copies every field **by name** at every level (generation, envelope, keyring, each wrap, each
  KDF). Nothing that sits beside these fields, now or in a later version, can ride along.
- **No earlier vault keys** (r2, CB-13): `previous` is uploaded empty. A restore never needs them, and they would open
  older copies whose own wraps do not. Their ids alone go in `retired` (review r3, S4; patch 4): a restore never lands
  on a key another file names as retired.
- **Never uploaded:** the PIN's records (`sk_pin`, `sk_pin_restart`), Touch ID / Windows Hello (`sk_prf`), plugin grants,
  settings, the security record, the diagnostics log, snapshots and the mirror: none is part of a generation, and a
  generation is all the function is given (a test writes them beside a real store and looks for them in the file). A
  keyring with a `device` wrap or a `deviceKey` is refused (`device_key`): that file would open with no secret.
- **`opens: "recovery"`** (the card's switch "只用恢复密钥打开"): the password wrap is left out, so only the 128-bit recovery
  key opens the file, and this file holds nothing to guess. It covers what is uploaded from then on: Sixkey deletes its
  own earlier copies (§1.2), but a copy someone already downloaded keeps its password wrap, and only a new vault key cuts
  it off from later uploads (CLOUD-BACKUP §1.5). It needs a recovery wrap (`no_wrap` otherwise); "both" needs the
  password wrap.
- **The result is parsed back** before it is returned, so what is uploaded is always what a restore accepts.
- **The parser is strict:** the exact set of fields at every level (one more or one fewer is `invalid_file`); wrap
  methods `password` and `recovery` only, once each, the password under PBKDF2 with kdf.ts's own iteration range
  (600,000 to 20,000,000, checked before anything is derived: CB-09) and the recovery key under HKDF; an empty
  `previous`; `opens` must say exactly what the wraps are; then the store's own checks (shape, checksum, key and data
  agreeing, `damaged` otherwise). A later version's file is `newer_format`, never `invalid_file`. The text is at most
  9 MiB in UTF-8 (an 8 MiB envelope, sync's limit, with its keyring and container) before JSON parsing.

### 1.2 The write rule and what it deletes (`rules.ts`)

`decideWrite(local, link, remote)`, in order: no link → create; the store's recovery mark → fork; another vault id →
fork; a save counter below the last upload there → fork; the file gone or in the trash → create again; nothing changed
(counter, key id, wraps, `opens`) → skip; a head revision other than the one this device wrote or restored from → fork;
otherwise overwrite. The wraps are compared as `wrapsOf` names them (each wrap's method and random IV; no secret): a
password change, a reset or a new recovery key at the same save counter is a change. `linkAfter` records the new head,
the wraps and the earlier files, and clears the mark; `adoptLink` starts a restored device at its own counter (the
counter is the store's, never compared with the one inside another device's file), with no earlier files;
`markRecovered` is for the store's recovery hook (patch 4). `parseCloudLink` returns null for anything it does not know,
which makes the next upload a new file that overwrites and deletes nothing. `nextName` gives "Sixkey 备份 (2).json".

What a device deletes (r2, CB-01): **never another device's file; only the latest version of its own.**

- `revisionsToDelete(revisions, newHead)`: after every upload, every revision of that file older than the one just
  written, by `modifiedTime` (Drive promises no order); never the new head, one written after it, or one marked Keep
  Forever; nothing when Drive does not list the new head.
- `pruneEvent(local, link, purged)`: another wrap than the last upload's, the switch between "both" and "recovery", or an
  account erased for good (the caller says so); never the first upload.
- `ownAfter(link, decision)`: the forks of rules 2, 3 and 4 leave a file this device wrote and nobody continues; it goes
  into `CloudLink.own` (at most `MAX_OWN`, 50; beyond that the oldest are forgotten, never deleted). A fork from another
  writer's file (rule 7) or a gone file (rule 5) leaves nothing of its own.
- The duty is kept until done (r3, R2-02): `CloudLink.pruneDue` from every upload until its older revisions are gone,
  `filesDue` from an event until a page holding the vault key has merged the earlier files and they are deleted;
  `linkAfter(…, dues)` and `withDues` write them, `parseCloudLink` reads them strictly; patch 2's run does the work.
  Revision ids, the link's head among them, are of Drive's id alphabet, `[A-Za-z0-9_-]` (R2-05).
- `ownFilesToDelete(own, heads, merged)`: at a prune event, an earlier file is deleted only when the page holding the
  vault key merged it into what was just uploaded, at the head this device wrote, and it is still at that head. One
  another writer continued is dropped from `own`, never deleted; one gone is dropped; one not merged (another vault's,
  left by a start over) or not looked at stays for a later prune.

Unchanged state with another writer's head is skipped, not forked: whoever overwrote it either restored from it and
merged, or is a clone that continued from it, so the head holds what this device uploaded. Under a race that is not so:
two writers of one lineage that read the same head within the same second both overwrite, and the one overwritten forks
only at its next upload that has a change; until then its last upload is on its own disk only (the other's upload
deletes the older revisions, and a restore reads heads). The model check below is atomic and says so; the race is
patch 2's test (CB-05).

### 1.3 The status (`status.ts`)

`cloudStatus(on, record, now)`: off; stopped (reconnect, Drive full, a vault too large for one upload, Google refusing
the app, no master password, unreadable vault: no retry fixes them); stale (a change waiting 3 days or more,
`STALE_AFTER_MS`); failed (a passing error, retried); waiting; ok. `popupSpeaks` is true for stopped and stale only.
Patch 2's `cloudErrorOf` maps every Drive code to one of these (CB-08).

### 1.4 Restore (`restore.ts`)

`openCloudBackups(candidates, secret, {now, device, budget?})`, newest first (Drive's time, then the save time, then the
id):

1. **Keys.** Each distinct wrap of the secret's method is tried once, however many files share it (one PBKDF2
   derivation per distinct password wrap), within `MAX_RESTORE_ITERATIONS` (40M) in all; a file past it is skipped as
   `limit` (CB-09). An empty password or a malformed recovery key is thrown as the secret's own mistake.
2. **Data.** Every file whose vault key is in hand opens, whether or not its own wrap fit the secret (a fork made before
   a password change: CB-06). Data that does not decrypt, or decrypts to another vault id, is `damaged`; a later vault
   schema is `newer`; a secret that opens nothing gives null.
3. **The vault, by vault** (CB-02). Every file is clamped (`clampVault`); the files of one vault are merged with
   `mergeVaults`; the newest file's vault is the base, and each other vault, merged first, adds its live accounts as new
   entries, skipping those the base has, its trash included (`addAccountsFrom`, the import's added mode). So the result
   depends on Drive's times only through which vault is the base.
4. **The key and the keyring** (CB-03; r3: R2-03, R2-04). The key: within the base vault, the newest, the one whose
   keyrings hold the newest wrap by `createdAt` (a tie goes to the newer file), never just the key of the file Drive
   changed last; `base` is the newest file under it, and `olderKeys` counts the vault's other keys among the files
   opened (their data is merged all the same). The keyring: that key's, no earlier keys, the newest recovery wrap by
   `createdAt`, and, after a password restore, the newest password wrap **the typed password opened**, so no clock can
   lock the user out; `outdated` says a password wrap dated later exists, and `password` is the spelling that opened the
   kept wrap. A recovery-key restore keeps the newest recovery wrap alone and sets `needsPassword`: the page asks for a
   new master password next, as the reset does. `createdAt` is not authenticated (CLOUD-BACKUP §3.6).

### 1.5 Tests (patch 1)

| File | What |
|---|---|
| `test/unit/cloudbk-format.test.ts` | the named fields at every level; no earlier vault keys, and the file still opens; a real store with the PIN, Touch ID, plugin and log records beside the vault; both secrets open "both"; device keys and device wraps refused; damage refused; the recovery-only file has nothing of the password wrap and still opens; 26 refusals (an earlier vault key, 599,999 and 20,000,001 iterations among them) and 3 kinds of damage in the parser, a real device wrap; the size cap with valid JSON, in UTF-8 bytes; two fast-check properties (junk beside the fields never changes the file; any field added anywhere makes it invalid) |
| `test/unit/cloudbk-rules.test.ts` | each rule and their order, the wraps among them; the links, compared whole, and the cleanup they owe (r3); 24 damaged-link cases (a dot-dot head and flags that are not true among them); names; `wrapsOf`, `pruneEvent`, `ownAfter`, `revisionsToDelete`, `ownFilesToDelete`; a fast-check model of three devices (edits, uploads, restores that merge and adopt, profile clones, recoveries, a new vault, new wraps) against one Drive: no overwrite drops what it replaced, every account ever uploaded is in the head of some file, a file holds one revision after every upload, and no merged earlier file is left after a prune event; under a rule that overwrites another writer's head, or deletes earlier files nobody merged, the same model loses an account, and a prune that deletes nothing is caught (the checks are not vacuous) |
| `test/unit/cloudbk-status.test.ts` | every state, `too_large` and `forbidden` among the stopping ones, and when the popup speaks; the 3-day edge |
| `test/unit/cloudbk-restore.test.ts` | one file by password and by recovery key (then the recovery wrap alone and `needsPassword`); recovery-only files and passwords; wrong and malformed secrets; forks merged with a later deletion winning; one derivation for a shared wrap (counted on `crypto.subtle.deriveKey`); a fork under an older wrap opened with the key in hand; every file clamped; damaged, foreign and later-schema files skipped; two vaults in both orders; another vault's accounts as new entries; the base vault's trash respected; the reviewer's two keyring scenarios; an outdated password, whose wrap is kept (r3, R2-04), and a clock that ran ahead; the newest key, though another key's file is newer in Drive (r3, R2-03), twice, the reviewer's probe among them; the work bound, a generated-shape password's second spelling counted; fast-check: random Drive times give the same vault, and with two vaults no account deleted in its vault's merge comes back and every live one is there |
| `test/helpers/cloud.ts` | protected keys at the test PBKDF2 count, accounts, vaults, generations, candidates |

### 1.6 Sizes (patch 1)

- Source: `format.ts` 192 lines (129 of code), `restore.ts` 241 (175), `rules.ts` 291 (177), `status.ts` 56 (36); in r1
  they were 184 (127), 141 (104), 117 (69) and 51 (34).
- Tests: 1,485 lines in four files, 61 in the helper.
- Builds: nothing imports `core/cloud`, so no bundle changes. `npm run check` (prod): popup 57,116 of 61,440 B gz, side
  panel 59,349 of 63,488, the same as at `2e260d0`; no budget was changed. `scripts/messages.py` writes no difference
  (no text was added).

## 2. Patch 2: the Drive client and the two exchanges

### 2.1 The Drive client (`drive.ts`)

`Drive` makes the Drive v3 requests the backup needs over a `DriveTransport` it is given (`send(request)`: method, URL,
headers, body; it rejects when no answer came). It never calls `fetch`: the service worker's transport, under the rules
of `platform/fetch-transport.ts`, comes with the network rules it belongs to (CSP, check-dist, the source rule that
`fetch` lives in one module) in patch 4, so this patch changes no network rule.

| Call | Request |
|---|---|
| `about()` | `GET drive/v3/about?fields=user(emailAddress)` |
| `list()` | `GET drive/v3/files?q=appProperties has { key='sixkey' and value='backup' } and trashed = false`, newest first, pages of 100 (`nextPageToken`) up to `MAX_LISTED` (200); then pages of 1,000 asking only `files(id)` to count the rest, up to `MAX_COUNTED` (10,000): `{files, notRead}` |
| `findFolder()`, `createFolder(name)`, `ensureFolder(name)` | the same search for `value='folder'` and the folder type; `POST drive/v3/files` with `appProperties: {sixkey: "folder"}` |
| `get(id)` | `GET drive/v3/files/{id}?fields=…`; 404 is null, a file in the trash comes back with `trashed` |
| `download(id)` | `GET drive/v3/files/{id}?alt=media` |
| `create(meta, content)` | `POST upload/drive/v3/files?uploadType=multipart`, JSON metadata (name, parent, description, `appProperties: {sixkey: "backup"}`) and the content, under a random boundary drawn again if the text holds it |
| `update(id, content)` | `PATCH upload/drive/v3/files/{id}?uploadType=media`: a new head revision |
| `revisions(id)` | `GET drive/v3/files/{id}/revisions?fields=nextPageToken,revisions(id,modifiedTime,keepForever)`, page after page |
| `deleteRevision(id, rev)` | `DELETE drive/v3/files/{id}/revisions/{rev}`: for good; false when it was gone |
| `deleteFile(id)` | `DELETE drive/v3/files/{id}`: for good, every revision, the trash skipped; false when it was gone |

- The token is in the `Authorization` header of every request, never in a URL; an id goes into a path only if it is
  Drive's shape (`[A-Za-z0-9_-]`, at most 200), a revision id likewise (r3, R2-05: nothing a URL parser folds, such
  as "..", gets in), a file id never one of Drive's words (`trash`, `generateIds`), and anything else is refused
  (`rejected`) before anything is sent.
- Every response field is checked (`bad_response` otherwise): id, name, head revision (files), RFC 3339 time, size,
  trash flag, app properties as text, a revision's id, time and keep-forever flag, a page token as text.
- One error type, `DriveError`, with a code and the status, and no URL, header, token or body: 401 `unauthorized`; 403
  `quota` (storageQuotaExceeded only), `rate_limited` (userRateLimitExceeded, rateLimitExceeded,
  sharingRateLimitExceeded, dailyLimitExceeded, or any reason of the domain `usageLimits`) or `forbidden` (the rest:
  domainPolicy, appNotAuthorizedToFile, …), per Drive's "Resolve errors" page (r2, CB-07); 404 `not_found`; 413 and over
  5 MiB before sending `too_large`; 429 `rate_limited`; 5xx `server`; other 4xx `rejected`; no answer `network`; a token
  provider that throws, `no_token` with nothing of its error, or its own `DriveError` passed on as a new one (CB-14).

### 2.2 The two exchanges (`remote.ts`)

- `runBackup(drive, {gen, opens, app, link, names, purged?, merged?, persist?})`: the file made and parsed back first (so a
  device-key keyring or a damaged generation sends nothing at all), the metadata read when there is a link,
  `decideWrite` with the uploaded wraps (`wrapsOf`, after the switch's filter), then skip, overwrite, or a new file in
  the folder under the first free name. Then what it deletes of its own (r2, CB-01): the file's revisions older than the
  one just written, and at a prune event (`pruneEvent`; `purged` says an account was erased for good) this device's
  earlier files that the caller merged (`merged`, each at the head it read), each looked up first (`ownFilesToDelete`).
  The result has the new link and `pruned` (`revisions`, `keptForever`, `keptNewer`, `files`, `failed`). A failure
  before the upload is thrown as it is, and the caller keeps the link it had, which stays right.
- The duty is kept until done (r3, R2-02). Right after the upload, before any deletion, the new link is handed to
  `persist` marked `pruneDue` (and `filesDue` at an event), so a worker stopped in the middle leaves a link that owes
  the work. Every run first does what its link owes, also a run whose decision is "skip": the older revisions of the
  link's file, and, given `merged`, the earlier files. A run without `merged` (the worker alone) leaves the earlier files
  and their duty to a page's run. `pruneDue` is cleared once nothing older is left (a file the user deleted counts as
  done), `filesDue` once every merged file is gone; a file left behind by a fork while its deletions were owed goes as a
  whole, once merged. A failed deletion is `pruned.failed`, and its duty stays for the next run.
- Drive v3 has no compare-and-swap on an update, so two writers can still meet between the read and the overwrite.
  That race is accepted and tested as it is: the one overwritten forks at its next upload that has a change, and until
  then its last upload is on its own disk only (CB-05).
- `fetchBackups(drive)`: every backup listed, downloaded and parsed, and `notRead` from the listing (CB-04); one that is
  not a backup, is damaged or is a later version's is named in `rejected`; a Drive error stops the restore. The head
  recorded is the listed one, so a file that changed in between makes the restored device fork at its first upload
  rather than overwrite (tested: CB-12, V16).
- `cloudErrorOf(e)`: the status line of every failure (CB-08): `unauthorized` and `no_token` → reconnect (after the
  worker's one retry with a fresh token, patch 4), `quota` → full, `forbidden` → forbidden, `too_large` → too_large,
  `network` → network, the rest (`rate_limited`, `not_found`, `rejected`, `server`, `bad_response`) → server, retried;
  the file's own refusals: a device key → no_password, damage → unreadable; anything else → unreadable.

### 2.3 The fake Drive (`test/helpers/fake-drive.ts`)

The requests above, answered as Drive answers them: files and folders with revisions, private app properties, the
trash, the `drive.file` scope (a copy the user uploads by hand is invisible), one token per device so each revision
names its writer, every grant revoked at once, a quota, injected statuses (401, 403 with a reason and a domain, 404,
413, 429, 5xx) or no answer, and the user deleting, trashing or replacing a file. In r2 it answers **only the fields a
request asks for**, and Drive's short default when it asks for none (CB-12, V19); it pages (`pageSize`, `pageToken`,
`nextPageToken`); it lists a file's revisions (newest first: Drive promises no order) and deletes one, never the head;
"Keep forever"; files deleted for good; `seed(n)` puts hundreds of files in at once. A request outside Drive's two API
roots, or with a token in its URL, throws.

### 2.4 Tests (patch 2)

| File | What |
|---|---|
| `test/unit/cloudbk-drive.test.ts` | every call against the fake; the folder made once; the list without the trash, folders or a copy uploaded by hand; 257 files listed over pages, 57 counted unread, and at most `MAX_COUNTED`; revisions over pages; a revision and a file deleted for good, and again (gone); deleted files; the token only in the header; ids, revision ids and sizes refused before sending; the boundary drawn again; the fake answering only the fields asked; 11 statuses and no answer mapped; 13 rows of 403 reasons with their domains, each rate reason also alone; a token provider's failure carrying nothing; revoked access; a full Drive keeping what it had; errors naming nothing; 7 unreadable listings and 4 unreadable revision lists |
| `test/unit/cloudbk-remote.test.ts` | (r3) the cleanup a link owes (R2-02): a deletion that fails at a password change done by the next run with nothing changed, the reviewer's probe fixed; a worker stopped in the middle of its deletions, and the next worker doing them; an event the worker met alone, done by a page's later run with no event, the reviewer's probe fixed; a file left behind while its deletions were owed; the owed cleanup of a file the user deleted; an earlier file that failed to delete deleted by the next run that has the merge. And, as in r2, with real vaults: first upload, overwrite and a restore, one revision left; no write when unchanged; the recovery-only switch; a file deleted or trashed made again; a file replaced by someone else forked; forks after a recovery, a new vault, an older counter; a device-key vault refused before any request; a full Drive, Drive's errors, no answer and revoked access leaving file and link as they were; two devices racing on one file; a restored device continuing its file; the restore's download naming junk, damaged and later files; a hand-made copy unseen; the latest copy only after the switch, a password change at the same save, and an account erased for good; Keep forever kept; a failed deletion; the earlier file deleted once merged, kept unmerged, forgotten when continued, never another device's; a purge as an event; 21 files restored, 203 with 3 unread; the listed head kept (V16); the race as it is (CB-05); the status of every code; a fast-check property: random histories of three devices sharing one vault (edits, uploads, restores, profile clones, recoveries) against the fake, the file written holding one revision after every upload, after which a restore has every account ever uploaded |

### 2.5 Sizes (patch 2)

- Source: `drive.ts` 400 lines (311 of code), `remote.ts` 258 (193); in r1 they were 271 (219) and 89 (64).
- Tests: 1,316 lines in two files, 365 in the fake.
- Builds: still nothing imports `core/cloud`; no bundle changes, no budget changed (§4).

## 3. Mutants

Hand-made mutants (a copy of the tree, each applied alone, the named test file run, the source restored and its hash
checked). A mutant counts as killed only when a test fails on an assertion and nothing timed out.

### 3.1 Patch 1

Patch 1 (r3): 88 mutants, all killed by an assertion, none by a timeout. They are the author's 30 of r1, adapted to r2
and r3 (F, R, S, X); the reviewer's 13 of round 1 that still have a target (V2, V3, V5 to V15: V1 and V4 tested the
upload of `previous`, which r2 removed, and N31 and N32 take their place); the 32 of r2 (N1 to N32); the reviewer's
round-2 survivor in patch 1, Q12; and 12 for round 2's fixes (K1 to K4 the newest key, W1 to W3 the typed password,
D1 to D5 the dues and revision ids). The reviewer's other round-2 mutants of patch 1 (Q1 to Q11, Q13) were killed in
the review and have their like here (N5 to N11, N19 to N23).

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| F1 | upload: the envelope copied whole, not by name (the parser's net still catches it) | cloudbk-format.test.ts › properties › fields beside the named ones, of any name and any value, never change the file |
| F2 | upload: the envelope copied whole and the parser's field check off (both layers gone) | cloudbk-format.test.ts › properties › any field added to a valid file, at any level, makes it invalid |
| F3 | upload: the keyring spread, a device key and unknown fields ride along (and the parser's check off) | cloudbk-format.test.ts › properties › any field added to a valid file, at any level, makes it invalid |
| F4 | upload: a device wrap is not refused | cloudbk-format.test.ts › what is never uploaded › a keyring that still holds a device key or a device wrap beside its master password |
| F5 | upload: a leftover device key is not refused | cloudbk-format.test.ts › what is never uploaded › a keyring that still holds a device key or a device wrap beside its master password |
| F6 | recovery-only: the password wrap kept (the parser's net still catches it) | cloudbk-format.test.ts › the parser › reads back what it wrote, field for field |
| F7 | recovery-only: the password wrap kept and the parser's `opens` rule off | cloudbk-format.test.ts › the parser › refuses a file for both without its password wrap |
| F8 | recovery-only: made without a recovery wrap (the no_wrap check off) | cloudbk-format.test.ts › the recovery-key-only file (the card's switch) › needs a recovery wrap; the file with both needs the password wrap |
| F9 | parser: any set of fields accepted | cloudbk-format.test.ts › properties › any field added to a valid file, at any level, makes it invalid |
| F10 | parser: a device wrap accepted (its method and its KDF) | cloudbk-format.test.ts › the parser › refuses a device wrap, with the KDF a device wrap has, beside the password and recovery wraps |
| F11 | parser: a later version called invalid | cloudbk-format.test.ts › the parser › names a later version's file as newer, never as damaged |
| F12 | parser: the store's checks skipped (checksum, key and data agreeing) | cloudbk-format.test.ts › the parser › calls a changed byte of the data damage |
| F13 | parser: a wrap's KDF not tied to its method | cloudbk-format.test.ts › the parser › refuses a password wrap under HKDF |
| R1 | overwrite: another writer's head ignored | cloudbk-rules.test.ts › decideWrite › another device wrote since: fork |
| R2 | overwrite: a save counter going backwards ignored | cloudbk-rules.test.ts › decideWrite › a counter below the last upload: fork |
| R3 | overwrite: another vault ignored | cloudbk-rules.test.ts › decideWrite › another vault: fork |
| R4 | overwrite: the recovery mark (just restored from an older copy) ignored | cloudbk-rules.test.ts › decideWrite › puts the rules in order: a recovery forks even when nothing else changed |
| R5 | overwrite: a file in the trash taken as there | cloudbk-rules.test.ts › decideWrite › puts the rules in order: a deleted file is made again even when nothing changed |
| R6 | overwrite: skip checked before a deleted file is made again | cloudbk-rules.test.ts › decideWrite › puts the rules in order: a deleted file is made again even when nothing changed |
| R7 | overwrite: a link after an upload keeps the recovery mark | cloudbk-rules.test.ts › decideWrite › a link after an upload or a restore continues the file at this store's counter, recovery mark cleared |
| R8 | stored link: unknown fields accepted | cloudbk-rules.test.ts › parseCloudLink › treats an unknown field as no link (the next upload makes a new file and overwrites nothing) |
| S1 | status: stale judged by the error's age, not by the changes waiting | cloudbk-status.test.ts › cloudStatus › changes waiting 3 days with no error recorded (the worker never ran) |
| S2 | status: the popup speaks on a passing failure | cloudbk-status.test.ts › cloudStatus › a passing failure, shown on the card only |
| X1 | restore: only the newest file of a vault, its forks dropped | cloudbk-restore.test.ts › properties › Drive's times decide the base, never the content: the same files give the same vault in any order |
| X2 | restore: another vault's accounts dropped | cloudbk-restore.test.ts › properties › two vaults: whichever file is newest, an account deleted in its vault's merge stays deleted, and every live one is there |
| X3 | restore: a shared wrap opened again for every file | cloudbk-restore.test.ts › several files of one vault › opens a wrap that several files share once (one key derivation for one keyring) |
| X4 | restore: a file whose data is another vault's taken | cloudbk-restore.test.ts › several files of one vault › skips a file whose keys open but whose data does not, or is another vault's, or a later schema's |
| X5 | restore: timestamps not clamped | cloudbk-restore.test.ts › several files of one vault › clamps every file's timestamps, not only the newest's (CB-12) |
| X6 | restore: the keys taken from the oldest file | cloudbk-restore.test.ts › one file › opens with the recovery key, a file for both and a recovery-only one alike, and then asks for a new password |
| X7 | restore: a deletion lost to an older file (merge replaced by taking the other side) | cloudbk-restore.test.ts › properties › Drive's times decide the base, never the content: the same files give the same vault in any order |
| V2 | a KDF copied whole (spread) and the parser's KDF field check off | cloudbk-format.test.ts › properties › any field added to a valid file, at any level, makes it invalid |
| V3 | parser: a recovery-only file may also carry a password wrap (maker unchanged) | cloudbk-format.test.ts › the parser › refuses a recovery-only file with a password wrap |
| V5 | parser: the 9 MiB size cap removed | cloudbk-format.test.ts › the parser › refuses text that is not JSON, and valid JSON larger than any vault, for its size (CB-12) |
| V6 | skip ignores `opens` (the recovery-only switch never uploaded at the same counter) | cloudbk-rules.test.ts › decideWrite › the switch to the recovery key only: overwrite |
| V7 | older-counter rule off by one | cloudbk-rules.test.ts › decideWrite › a counter below the last upload: fork |
| V8 | a stored recovery mark is dropped when the link is read back | cloudbk-rules.test.ts › parseCloudLink › reads a link back, with and without the recovery mark |
| V9 | a restored device adopts its file at counter 0 | cloudbk-rules.test.ts › decideWrite › a link after an upload or a restore continues the file at this store's counter, recovery mark cleared |
| V10 | another writer's head checked before the skip (unchanged state forks) | cloudbk-rules.test.ts › decideWrite › skips an unchanged state even when another device wrote since: what it uploaded is in the head already |
| V11 | restore: only the first file clamped, the others merged unclamped | cloudbk-restore.test.ts › several files of one vault › clamps every file's timestamps, not only the newest's (CB-12) |
| V12 | restore: another vault's accounts checked against live accounts only (trash ignored) | cloudbk-restore.test.ts › several vaults (CB-02) › does not bring back as new an account that sits in the base vault's trash (CB-12) |
| V13 | restore: the derivation cache keyed by vault key id only (another wrap of that key not tried) | cloudbk-restore.test.ts › the restored keyring (CB-03) › a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept |
| V14 | restore: the secret's own mistakes swallowed as 'opens nothing' | cloudbk-restore.test.ts › one file › a wrong password or recovery key opens nothing; an empty password or a malformed key is the secret's mistake |
| V15 | restore: Drive's modification time ignored in the order | cloudbk-restore.test.ts › one file › opens with the recovery key, a file for both and a recovery-only one alike, and then asks for a new password |
| N1 | CB-01: skip ignores the wraps (a password change at the same counter never uploaded) | cloudbk-rules.test.ts › decideWrite › new wraps at the same counter: overwrite |
| N2 | CB-01: a new wrap is not a prune event | cloudbk-rules.test.ts › the write rule over random histories of three devices › is not vacuous: deleting an earlier file that was not merged loses an account, and a lazy prune is caught |
| N3 | CB-01: the switch to recovery-only is not a prune event | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › a prune event: another wrap, the switch between both and recovery, or an erased account; never the first upload |
| N4 | CB-01: an account erased for good is not a prune event | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › a prune event: another wrap, the switch between both and recovery, or an erased account; never the first upload |
| N5 | CB-01: a revision newer than the one just written deleted too (a racing writer's head) | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › after an upload: every revision older than the one just written, never it, a newer one or a kept one |
| N6 | CB-01: a revision the user marked Keep forever deleted | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › after an upload: every revision older than the one just written, never it, a newer one or a kept one |
| N7 | CB-01: only the newest older revision deleted (the rest of the history left) | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › after an upload: every revision older than the one just written, never it, a newer one or a kept one |
| N8 | CB-01: a head Drive does not list taken as license to delete every revision | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › after an upload: every revision older than the one just written, never it, a newer one or a kept one |
| N9 | CB-01: an earlier file deleted though nobody merged it | cloudbk-rules.test.ts › the write rule over random histories of three devices › is not vacuous: deleting an earlier file that was not merged loses an account, and a lazy prune is caught |
| N10 | CB-01: an earlier file another writer continued deleted (another device's file) | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › at a prune event: an earlier file goes only when merged and still at that head; another writer's never |
| N11 | CB-01: a file merged at another head counts as merged | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › at a prune event: an earlier file goes only when merged and still at that head; another writer's never |
| N12 | CB-01: a fork from another writer's file takes that file as its own | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › a fork that leaves this device's own file remembers it; another writer's file or a gone one is not its |
| N13 | CB-01: the link after an upload forgets the earlier files | cloudbk-rules.test.ts › decideWrite › a link after an upload or a restore continues the file at this store's counter, recovery mark cleared |
| N14 | CB-01: the wraps named by method only (a new password of the same method unseen) | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › wrapsOf names the wraps by method and IV, in one order |
| N15 | CB-01: a stored link's wraps not checked | cloudbk-rules.test.ts › parseCloudLink › treats a device wrap in the wraps as no link (the next upload makes a new file and overwrites nothing) |
| N16 | CB-01: over MAX_OWN, the newest earlier file forgotten instead of the oldest | cloudbk-rules.test.ts › what a device deletes of its own (review r2, CB-01) › a fork that leaves this device's own file remembers it; another writer's file or a gone one is not its |
| N17 | CB-02: another vault taken from its oldest file, not its merge (the v1 order bug) | cloudbk-restore.test.ts › properties › two vaults: whichever file is newest, an account deleted in its vault's merge stays deleted, and every live one is there |
| N18 | CB-03: the newest file's keyring taken whole (v1) | cloudbk-restore.test.ts › the restored keyring (CB-03) › a password older than another computer's restores, says so, and the restored keyring keeps it (R2-04) |
| N19 | CB-03: the first wrap seen kept, createdAt ignored | cloudbk-restore.test.ts › the restored keyring (CB-03) › a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept |
| N20 | CB-03: a recovery-key restore keeps the password wrap | cloudbk-restore.test.ts › one file › opens with the recovery key, a file for both and a recovery-only one alike, and then asks for a new password |
| N21 | CB-03: an outdated password never said | cloudbk-restore.test.ts › the restored keyring (CB-03) › a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept |
| N22 | CB-03: the newest wrap taken from files under another vault key too | cloudbk-restore.test.ts › the restored keyring (CB-03) › takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03) |
| N23 | CB-06: a file opens only through its own wrap (the held vault key not tried) | cloudbk-restore.test.ts › several files of one vault › opens a fork whose wrap the password no longer fits with the vault key in hand (CB-06) |
| N24 | CB-08: too_large retried for ever | cloudbk-status.test.ts › cloudStatus › a vault too large for one upload |
| N25 | CB-08: forbidden retried for ever | cloudbk-status.test.ts › cloudStatus › Google refuses the app (an admin's policy) |
| N26 | CB-09: the restore's PBKDF2 budget never charged | cloudbk-restore.test.ts › the work a restore does (CB-09) › derives within its budget, and skips a file past it as 'limit' |
| N27 | CB-09: the parser takes more than kdf.ts's most iterations | cloudbk-format.test.ts › the parser › refuses a password wrap above the ceiling |
| N28 | CB-09: the parser takes fewer than kdf.ts's least iterations | cloudbk-format.test.ts › the parser › refuses a password wrap below PBKDF2's floor (CB-09: refused before anything is derive |
| N29 | CB-09: a file past the budget named as the secret's, not as the limit | cloudbk-restore.test.ts › the work a restore does (CB-09) › derives within its budget, and skips a file past it as 'limit' |
| N30 | CB-12: the size cap counted in UTF-16 units, not UTF-8 bytes | cloudbk-format.test.ts › the parser › refuses text that is not JSON, and valid JSON larger than any vault, for its size (CB-12) |
| N31 | CB-13: the earlier vault keys uploaded, and the parser takes them | cloudbk-format.test.ts › the parser › refuses an earlier vault key (never uploaded, CB-13) |
| N32 | CB-13: the parser takes a file with earlier vault keys (maker unchanged) | cloudbk-format.test.ts › the parser › refuses an earlier vault key (never uploaded, CB-13) |
| Q12 | (the reviewer's) CB-09: a generated-shape password's second try not counted | cloudbk-restore.test.ts › the work a restore does (CB-09) › counts a generated-shape password's second spelling in the budget |
| K1 | R2-03: the key of the file Drive changed last (r2) | cloudbk-restore.test.ts › the restored keyring (CB-03) › takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03) |
| K2 | R2-03: the files under an older key never said | cloudbk-restore.test.ts › the restored keyring (CB-03) › takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03) |
| K3 | R2-03: the newest key judged by the first wrap seen, createdAt ignored | cloudbk-restore.test.ts › the restored keyring (CB-03) › takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03) |
| K4 | R2-03: the base file the newest one Drive lists, whatever its key | cloudbk-restore.test.ts › the restored keyring (CB-03) › takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03) |
| W1 | R2-04: the newest password wrap kept, not the one typed (r2) | cloudbk-restore.test.ts › the restored keyring (CB-03) › a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept |
| W2 | R2-04: outdated judged without the dates (never said after a typed, opened wrap) | cloudbk-restore.test.ts › the restored keyring (CB-03) › a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept |
| W3 | R2-04: the spelling that opened the kept wrap not returned | cloudbk-restore.test.ts › one file › opens with the master password: the same vault, the same keys, and the spelling that opened it |
| D1 | R2-02: a link after an upload forgets the revisions it still owes | cloudbk-rules.test.ts › decideWrite › a link carries the cleanup it still owes, and gives it up only when told (review r3, R2-02) |
| D2 | R2-02: a link's old dues kept though the work is done | cloudbk-rules.test.ts › decideWrite › a link carries the cleanup it still owes, and gives it up only when told (review r3, R2-02) |
| D3 | R2-02: a stored link's flags taken whatever their value | cloudbk-rules.test.ts › parseCloudLink › treats a cleanup flag that is not true as no link (the next upload makes a new file and overwrites nothing) |
| D4 | R2-02: a stored link's revisions duty dropped when read back | cloudbk-rules.test.ts › parseCloudLink › reads a link back, with and without the recovery mark |
| D5 | R2-05: a revision id of any printable characters (a dot-dot head) taken | cloudbk-rules.test.ts › parseCloudLink › treats a head that is a path's dot-dot (R2-05) as no link (the next upload makes a new file and overwrites nothing) |

### 3.2 Patch 2

Patch 2 (r3): 63 mutants, all killed by an assertion, none by a timeout. They are the author's 20 of r1, adapted to r2
and r3 (D, M); the reviewer's V16 to V19; the 28 of r2 (P1 to P12, L1 to L5, E1 to E3, S1 to S5, K1 to K3); and 11 for
round 2's fixes (R1 to R9 the duty kept until done, I1 and I2 revision ids and Drive's words).

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| D1 | Drive full (403 storageQuotaExceeded) taken as forbidden | cloudbk-drive.test.ts › errors › 403 storageQuotaExceeded (global) is the code Drive's error page implies (CB-07)undefined |
| D2 | a rate limit's 403 taken as forbidden | cloudbk-drive.test.ts › errors › 403 dailyLimitExceeded (global) is the code Drive's error page implies (CB-07) (its reason  |
| D3 | Drive's 5xx taken as no answer | cloudbk-drive.test.ts › errors › 500 is 500 |
| D4 | a deleted file (404) thrown, not null | cloudbk-drive.test.ts › the calls › a file the user deleted is null; its download is not_found |
| D5 | the token also sent in the URL | cloudbk-drive.test.ts › errors › 400 is 400 |
| D6 | the transport's error (URL, token) carried in the DriveError | cloudbk-drive.test.ts › errors › an error names no URL, header, token or body |
| D7 | a file without a head revision accepted | cloudbk-drive.test.ts › errors › an answer that cannot be read is bad_response: a file without a head revision |
| D8 | a new file made without the app property a restore looks for | cloudbk-drive.test.ts › the calls › asks for every field it reads: the fake, like Drive, answers only those (CB-12, V19) |
| D9 | the trash listed with the backups | cloudbk-drive.test.ts › the calls › lists only the app's backups that are not in the trash, newest first |
| D10 | an id put in a path unchecked | cloudbk-drive.test.ts › the calls › refuses an id that is not Drive's, before sending anything |
| D11 | a new file over 5 MiB sent anyway | cloudbk-drive.test.ts › the calls › refuses an upload over 5 MiB before sending anything |
| D12 | the multipart boundary not drawn again when the content holds it | cloudbk-drive.test.ts › the calls › draws the multipart boundary again when the content holds it |
| M1 | an overwrite keeps the old head in the link (the next upload would fork for nothing) | cloudbk-remote.test.ts › one device › makes the folder and the file first, then overwrites it, and a restore gets the vault back |
| M2 | a fork takes the first file's name | cloudbk-remote.test.ts › one device › a file replaced by someone else is not overwritten: the next save goes to a new file beside it |
| M3 | an unchanged vault uploaded again | cloudbk-remote.test.ts › one device › an unchanged vault sends no write at all |
| M4 | the file's head not read (taken to be this device's) | cloudbk-remote.test.ts › one device › a file replaced by someone else is not overwritten: the next save goes to a new file beside it |
| M5 | the generation uploaded as it is, not the container | cloudbk-remote.test.ts › a restore past the first page (CB-04) › reads every file of 21, the oldest one's account included |
| M6 | the card's switch ignored (always both wraps) | cloudbk-remote.test.ts › one device › the switch to the recovery key only overwrites the file with one that has no password wrap |
| M7 | the restore's download: a Drive error taken as an invalid file | cloudbk-remote.test.ts › the restore's download › does not see a copy the user uploaded by hand (drive.file), and stops on a Drive error |
| M8 | the restore's download names a later version's file invalid | cloudbk-remote.test.ts › the restore's download › names files that are not a backup, are damaged or are a later version's, and takes the rest |
| V16 | restore download: the head read again after the download (newer head than content) | cloudbk-remote.test.ts › the head a restore keeps (CB-12, V16) › is the one listed: a file rewritten after the listing is forked from, never overwritten |
| V17 | a file's trash flag always read as false | cloudbk-drive.test.ts › the calls › lists only the app's backups that are not in the trash, newest first |
| V18 | any other 403 taken as a rate limit (retried for ever) | cloudbk-drive.test.ts › errors › 403 appNotAuthorizedToFile (global) is the code Drive's error page implies (CB-07)undefined |
| V19 | headRevisionId and trashed not asked for in `fields` (real Drive would then omit them) | cloudbk-drive.test.ts › errors › a full Drive refuses a new file and an overwrite, and keeps what it had |
| P1 | CB-01: no revision deleted after an upload | cloudbk-remote.test.ts › one device › makes the folder and the file first, then overwrites it, and a restore gets the vault back |
| P2 | CB-01: the revisions pruned against the old head, not the one just written | cloudbk-remote.test.ts › one device › makes the folder and the file first, then overwrites it, and a restore gets the vault back |
| P3 | CB-01: a failed deletion after the upload thrown (the new link lost) | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a deletion that fails at a password change is done by the next run, though nothing changed since |
| P4 | CB-01: the wraps of the generation, not of the file uploaded (the switch's filter unseen) | cloudbk-remote.test.ts › the latest copy only (CB-01) › under the recovery key only, a password change changes nothing in the file: nothing is uploaded |
| P5 | CB-01: the purge flag not passed on (an erased account is no event) | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › an account erased for good is an event too; with no event nothing of its own is deleted |
| P6 | CB-01: the earlier files' heads not looked up (taken as unchanged) | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › keeps an earlier file nobody merged, and only forgets one another writer continued |
| P7 | CB-01: an earlier file that failed to delete is forgotten | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › an earlier file that fails to delete is remembered, and deleted by the next run that has the merge |
| P8 | CB-01: the earlier files deleted though nobody merged them | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › keeps an earlier file nobody merged, and only forgets one another writer continued |
| P9 | CB-01: a file deleted into the trash, not for good (a PATCH trashed=true) | cloudbk-drive.test.ts › the calls › lists a file's revisions, deletes one for good, and deletes a file for good, the trash skipped (CB-01) |
| P10 | CB-01: a revision that was gone already taken as an error | cloudbk-drive.test.ts › the calls › lists a file's revisions, deletes one for good, and deletes a file for good, the trash skipped (CB-01) |
| P11 | CB-01: only the first page of revisions read | cloudbk-drive.test.ts › the calls › reads a file's revisions over several pages |
| P12 | CB-01: a revision id put in a path unchecked | cloudbk-drive.test.ts › the calls › refuses an id that is not Drive's, before sending anything |
| L1 | CB-04: one page only (v1) | cloudbk-drive.test.ts › the calls › lists page after page up to MAX_LISTED, newest first, and counts the ones it did not read (CB-04) |
| L2 | CB-04: the files beyond the cap not counted | cloudbk-drive.test.ts › the calls › counts at most MAX_COUNTED files it did not read |
| L3 | CB-04: the count not capped | cloudbk-drive.test.ts › the calls › counts at most MAX_COUNTED files it did not read |
| L4 | CB-04: fetchBackups drops the count | cloudbk-remote.test.ts › a restore past the first page (CB-04) › beyond MAX_LISTED, says how many it did not read |
| L5 | CB-04: the cap ignored (every file read) | cloudbk-drive.test.ts › the calls › counts at most MAX_COUNTED files it did not read |
| E1 | CB-07: dailyLimitExceeded not a rate limit | cloudbk-drive.test.ts › errors › 403 dailyLimitExceeded (global) is the code Drive's error page implies (CB-07) (its reason  |
| E2 | CB-07: the usageLimits domain ignored | cloudbk-drive.test.ts › errors › 403 quotaExceeded (usageLimits) is the code Drive's error page implies (CB-07)undefined |
| E3 | CB-07: quotaExceeded taken as Drive full again (v1) | cloudbk-drive.test.ts › errors › 403 quotaExceeded (global) is the code Drive's error page implies (CB-07)without the usageL |
| S1 | CB-08: Drive full shown as a passing error | cloudbk-remote.test.ts › the status of every failure (CB-08) › Drive's quota is full |
| S2 | CB-08: forbidden shown as a passing error | cloudbk-remote.test.ts › the status of every failure (CB-08) › Drive's forbidden is forbidden |
| S3 | CB-08: too_large shown as a passing error | cloudbk-remote.test.ts › the status of every failure (CB-08) › Drive's too_large is too_large |
| S4 | CB-08: a lost token shown as a passing error | cloudbk-remote.test.ts › the status of every failure (CB-08) › Drive's no_token is reconnect |
| S5 | CB-08: a device-key vault shown as unreadable | cloudbk-remote.test.ts › the status of every failure (CB-08) › the file's own refusals are the vault's, and anything else is the vault failing to read |
| K1 | CB-14: the token provider's error thrown as it is | cloudbk-drive.test.ts › errors › a token provider's failure carries nothing of it, and nothing is sent (CB-14) |
| K2 | CB-14: the auth layer's DriveError passed on as the same object (its message along) | cloudbk-drive.test.ts › errors › a token provider's failure carries nothing of it, and nothing is sent (CB-14) |
| K3 | CB-14: the auth layer's own code lost (everything no_token) | cloudbk-drive.test.ts › errors › a token provider's failure carries nothing of it, and nothing is sent (CB-14) |
| R1 | R2-02: an owed deletion not done by a run that uploads nothing (r2) | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a deletion that fails at a password change is done by the next run, though nothing changed since |
| R2 | R2-02: owed earlier files not deleted by a run that uploads nothing | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › an event the worker met alone waits for a page's merge, and the earlier file goes then, with no event |
| R3 | R2-02: the new link not saved before the deletions (a stopped worker loses the duty) | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a worker stopped in the middle of its deletions leaves a link that owes them, and the next worker does them |
| R4 | R2-02: the files duty not carried from one run to the next | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a file left behind while its older revisions were still owed goes as a whole, once merged |
| R5 | R2-02: an event the worker met alone counted as done (merged taken as empty) | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a file left behind while its older revisions were still owed goes as a whole, once merged |
| R6 | R2-02: the revisions duty cleared though the deletion failed | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a deletion that fails at a password change is done by the next run, though nothing changed since |
| R7 | R2-02: an owed deletion of a file the user deleted counted as failed (owed for ever) | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › the owed cleanup of a file the user deleted is done: nothing is left of it |
| R8 | R2-02: a file left behind while its deletions were owed forgotten | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a file left behind while its older revisions were still owed goes as a whole, once merged |
| R9 | R2-02: the files duty cleared though a deletion failed | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › an earlier file that fails to delete is remembered, and deleted by the next run that has the merge |
| I1 | R2-05: a revision id of any printable characters ("..") put in a path | cloudbk-drive.test.ts › errors › a revisions answer that cannot be read is bad_response: a revision id that is a path's dot- |
| I2 | R2-05: Drive's reserved words ("trash") taken as file ids | cloudbk-drive.test.ts › the calls › refuses an id that is not Drive's, before sending anything |

## 4. Gates run

On the tree of patch 1 r3 (`2e260d0` + patch 1 r3), 2026-10-31, each under `nice -n 19` in the shared lock:
`python3 scripts/messages.py` (no file changes), `npm run typecheck`, `npm run build`, `npm run check` (prod: popup 57,116
of 61,440 B gz, side panel 59,349 of 63,488, `check-dist (prod) OK`), `npm run format:check`, `npm run notices:check`, and
the targeted unit run `npx vitest run --maxWorkers=2` of the four `cloudbk-*` files with `source-rules` and
`m5-source-rules` (6 files, 147 tests, all passed).

On the tree of patches 1 and 2 r3 (`2e260d0` + both), 2026-10-31, the same gates: `scripts/messages.py` (no file
changes), typecheck, build, check (prod: popup 57,116 of 61,440 B gz, side panel 59,349 of 63,488, the same as at
`2e260d0`; `check-dist (prod) OK`), format:check, notices:check; the targeted run of the six `cloudbk-*` files with
`source-rules` and `m5-source-rules` (8 files, 247 tests, all passed). The full unit suite was run once, on the final
tree: the three patches together on the repository's `4b2ec0e` (patch 3's notes).

## 5. Patch 3: the sign-in, the transport and the developer cloud page

### 5.1 The client IDs (`scripts/google-oauth.mjs`)

The one place the OAuth client IDs are written: per flavour, a "Chrome Extension" client (for `getAuthToken`) and a
"Web application" client (for `launchWebAuthFlow`), all "" until the owner makes them (CLOUD-BACKUP.md §7.1). A value
that is not a Google client ID stops the build. `scripts/build.mjs` puts the flavour's pair in the code
(`__GOOGLE_CLIENTS__`) and, only for the dev build and only once its Chrome client is set, writes the manifest's
`oauth2` key (`{client_id, scopes: [drive.file]}`), which `getAuthToken` reads; with no client there is no key, and the
sign-in says "not configured" without touching `chrome.identity`. The e2e build never has clients. The dev clients are made in a Cloud project of their own, "Sixkey dev", since `drive.file` grants are per
project (CLOUD-BACKUP §7.1, P3-03). A flavour's two clients, the Chrome one and the web one, must be in the same
project: revoking one token withdraws the whole grant only because the grant is the project's, and a file made through
one client is listed through the other only within a project (CLOUD-BACKUP §7.1 item 4; REVIEW-P5P6-r3, C4).

### 5.2 The sign-in (`src/platform/google-auth.ts`)

`GoogleAuth` over injected `chrome.identity`, `chrome.permissions` and `chrome.storage.session`:

- `requestIdentityPermission()` asks for the optional `identity` permission and nothing else; a click handler calls it
  as its first statement (a source rule holds both call sites to that). `identity` has no warning, so Chrome grants it
  without a dialog. No other function asks for it: without it every call is `no_permission`.
- `connect(path)`, the one interactive call, for a page in a tab: "chrome", `getAuthToken({interactive: true})` for
  drive.file (the token stays in Chrome's cache; nothing is stored); "web", `launchWebAuthFlow` to Google's documented
  URL (`response_type=token`, a random 128-bit `state`, `prompt=select_account`), Google's redirect checked (this
  extension's `chromiumapp.org` address, the state, Bearer, drive.file, 60 s to 24 h) and its token kept in
  `storage.session` under `sk_cloud_token` with its expiry, nowhere else.
- `token(path)`, with no UI at all, for the worker: Chrome's cache, or the kept token until 5 minutes before it expires,
  then a silent flow (`interactive: false`, `prompt=none`, `abortOnLoadForNonInteractive: false`, 10 s) that names the
  account recorded at connect as `login_hint` (`hint`, P3-r2: P3-01). Anything that would need the user is
  `needs_consent` (the status line's "重新连接"), never a prompt.
- `dropToken` (after a 401), `disconnect(revoke)`: every token held revoked through the caller's transport, whatever is
  left of its lifetime (P3-02: `heldToken`, not the renewal margin's `liveToken`), Chrome's cache cleared, the session
  record removed, `identity` given back; each step runs when an earlier one fails.
- `AuthError` carries its code only: Chrome's messages and Google's redirects never reach a message or a log.

### 5.3 The transport (`src/platform/google-transport.ts`)

The second module that calls `fetch`, under the sync transport's rules: Drive's two API roots only (judged on the
parsed URL, so a path that climbs out is judged where it goes; no userinfo, port or fragment), and within them only the
endpoints `drive.ts` calls, each with its one method (P3-r2, R2-05: `ENDPOINTS()`, `allowed`; the list is built on
first use, since a RegExp made at the top level stayed in the prod worker until it was): about; files' list, get,
create and delete; a file's revisions, listed and deleted; the two uploads; ids of Drive's alphabet, never `trash` or
`generateIds`. No cookies, cache, referrer or redirects, `Accept-Language: *`, 60 s, 9 MiB; `revoke(token)` posts the
token in a form body to `https://oauth2.googleapis.com/revoke`. Every failure is `GoogleNetworkError`, which says "network" and nothing else.
In patch 3 only the dev build's worker builds one (the source rule in `m5-source-rules.test.ts` now names the two
transports and that one builder); patch 4 gives the store build its own.

### 5.4 The developer cloud page (`src/devcloud/`, `src/platform/devcloud-worker.ts`)

The dev build's page for CLOUD-BACKUP.md §7.2, at `chrome-extension://pgnlbjikdnniepfeijffpefifnojjege/devcloud/index.html`.
The sign-in runs in the page: the click asks for `identity`, then the page opens itself in a new tab, which connects as
it loads with no click (the maintainers' amendment: the popup's "立即备份" will open the settings page the same way).
Everything else runs in the worker, the one context that reaches the network: the page's one message, `sk-devcloud`
(a table of its own in `sender-policy.ts`, like the content script's: no row in MESSAGE_SENDERS, taken only from that
page and only in the dev build), goes to a fourth listener that `sw.ts` registers behind `__CLOUD_DEV__`. Its checks:
a token with no window and the account it is for (Drive's about.get, the account pin's call: 5, and 6b for the web
path's silent renewal), a test file uploaded to My Drive › Sixkey-dev with `sixkey: "devcheck"` (P3-03: no restore lists
it, and the page lists only its own),
listed (with the count of what was not read), downloaded and compared, overwritten with the write rule shown refusing a
writer that still holds the old head, and then the latest-copy rule's two deletions under `drive.file`: the older
revisions deleted and a scratch file made and deleted for good (2–4; r2), and disconnect (7). A reply holds a yes or no
and a line of detail (names, ids, revision ids, the account, error codes), never a token. The page itself keeps `connect-src 'none'` like every page.

The build: the page is an input of the dev build only, and a guard fails a prod or e2e build whose module graph reaches
`src/devcloud/`. The dev manifest overlay adds `identity` to the optional permissions and Google's two API origins to
the CSP (`scripts/api-origin.mjs` `cspOf(origin, extra)`). check-dist, per flavour: dev must have the page with its
marker, a worker that answers it, `identity`, the CSP with Google, and `oauth2` exactly as configured (or none); prod and
e2e must have no `devcloud/`, no `identity`, no `oauth2`, the CSP of before, and no shipped file with the page's marker,
its message, `sk_cloud_token` or `googleapis.com`.

### 5.5 The account pin (P3-r2: P3-01)

`drive.ts` `about()` asks for `user(emailAddress,permissionId)`: `permissionId` is Drive's own id for the account ("The
user's ID as visible in Permission resources"; that it stays when the address changes is [inferred], review r3 S5;
`emailAddress` "may not be present", and the pin then holds the id alone), and `about.get` needs no scope beyond `drive.file` (Google's tokeninfo would need the
token in a URL; userinfo the `openid` or `email` scope, one more consent line). `remote.ts` `pinAccount(drive)` gives
`{id, email}` to record at connect; `runBackup`'s `account`, when given, asks about.get first and throws
`wrong_account` (status "reconnect", `cloudErrorOf`) before anything is read or written when the token is another
account's. `google-auth.ts`'s `hint` gives the recorded address to the silent renewal as `login_hint`. The fake Drive
has accounts: each client a token of one, each file in one account's Drive, seen by that account's tokens only, and
about.get naming the token's account. The call sites, at connect and in every run, are patch 4's (CLOUD-BACKUP §8): the
worker's wiring is where `sk_cloud_cfg` lives.

### 5.6 Tests (patch 3)

| File | What |
|---|---|
| `test/unit/cloudbk-auth.test.ts` | (P3-r2) the redirect's path checked (Q14); each flow's own random state (Q20); the silent renewal's login_hint, and none without a pin or when it cannot be read (P3-01); disconnect revoking a token with minutes or none left (P3-02). And over fake chrome.identity, permissions and session: no client, no permission (nothing called, nothing asked); the permission asked at once in the caller's task; each path's connect, refusals and bad answers (8 cases), silent tokens and renewals that never become interactive, dropped tokens; the token in no URL handed to the browser and in no error; disconnect revoking everything even when revoking fails; the pure parts |
| `test/unit/cloudbk-transport.test.ts` | (P3-r2) 11 requests under Drive's roots that the backup never makes refused (emptying the trash, sharing, a folded dot-dot, metadata patches, …), and the 9 it makes taken (R2-05). And over a fake fetch: the request's discipline, Drive's deletions sent with no body, 11 URLs refused before anything is sent, parsed-form judging, methods and headers, the revocation's body and URL, failures that name nothing, a timeout, both size limits, a body that is not UTF-8 |
| `test/unit/cloudbk-devcloud.test.ts` | (P3-r2) the page's files apart from the backups, both ways (P3-03); the silent check naming the account. And the worker end's checks against the fake Drive (the rewrite leaving one revision and deleting its scratch file for good); failures as codes; 7 bad requests; no reply holds the token; the listener answers the developer page only, and only in the dev build |
| `test/unit/cloudbk-auth-rules.test.ts` | source rules: `chrome.identity` in one module; `identity` asked for there only and called only as a click's first statement; the two interactive calls in `connect()`, never in the worker's code; the token record's one key and no other storage; no URL built with a token |
| patch 2's, updated | (P3-r2) `cloudbk-drive.test.ts`: the account's id, accounts apart, the developer kind; `cloudbk-remote.test.ts`: the account pin (another account's token writes nothing; `pinAccount`), `wrong_account` in the status table |
| existing, updated | `m5-source-rules` (two transports, one builder each; the dev CSP; the page linked from nowhere), `autofill-pre-source-rules` (the page's message table, the fourth listener and its gate), `autofill-pre-sender` (the page a surface in the dev build only, sending no row's type) |

A smoke run of the dev build in Playwright's Chromium, with no network and no client (outside the patch): the page
loads with no error and says "not configured"; the worker answers its message with `not_configured` (silent, upload) and
`bad request`; the settings page's message of the same type gets no answer; a fetch from the page is refused by its CSP.

### 5.7 Mutants (patch 3)

42 mutants, all killed by an assertion, none by a timeout: the 28 of patch 3 on r2 rerun on r3 (A1 to A16, T1 to T7,
W1 to W5; W1, T7, A2 and A11 rewritten for the new code), the reviewer's round-2 survivors Q14 and Q20, and 12 for the
round-2 points (AP1 to AP4 the account pin, RV1 the revocation, DC1 to DC3 the developer files, EP1 to EP4 the
allowlist). Q21 is equivalent (P3-04 in §0) and not run.

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| A1 | Chrome path: a silent failure retried with Google's window | cloudbk-auth.test.ts › the Chrome path › a token with no UI: when Chrome would have to ask, it is needs_consent, and nothing interactive ever runs |
| A2 | web path: a silent renewal that fails opens the interactive flow | cloudbk-auth.test.ts › the web path › a silent renewal that cannot finish is needs_consent, and never turns into Google's window |
| A3 | web path: the silent renewal asks with prompt=select_account (a window may show) | cloudbk-auth.test.ts › the pure parts › authUrl adds a login hint when given, and asks for nothing but drive.file |
| A4 | connect() asks for the permission itself (not in the click) | cloudbk-auth.test.ts › nothing without a client or the permission › without the permission every call is no_permission, and none asks for it (only a click does) |
| A5 | requestIdentityPermission awaits before it asks (the gesture is spent) | cloudbk-auth.test.ts › nothing without a client or the permission › requestIdentityPermission asks for `identity` alone, at once, in the same task as the click |
| A6 | the developer page's click awaits before asking for the permission | cloudbk-auth-rules.test.ts › the sign-in's call sites › the `identity` permission is asked for in the auth module only, and called only as a click handler's first statement |
| A7 | Chrome path: the token also kept in session memory | cloudbk-auth.test.ts › the Chrome path › connects with one interactive call for drive.file, and keeps nothing: the token stays in Chrome's cache |
| A8 | web path: a kept token used past its expiry | cloudbk-auth.test.ts › the pure parts › readRedirect maps Google's silent errors, and liveToken refuses a damaged or due record |
| A9 | a token Drive refused is not dropped from Chrome's cache | cloudbk-auth.test.ts › the Chrome path › a token Drive refused is dropped from Chrome's cache, and the next one is another |
| A10 | disconnect leaves the permission granted | cloudbk-auth.test.ts › where a token never is › disconnect revokes every token held, drops every copy and gives the permission back, even when revoking fails |
| A11 | the silent renewal carries the old token as a hint in its URL | cloudbk-auth.test.ts › the web path › the silent renewal names the account recorded at connect (login_hint), and only the renewal (P3-01) |
| A12 | an error carries Google's answer (with its token) | cloudbk-auth.test.ts › where a token never is › never in a URL Sixkey hands to the browser, never in an error |
| A13 | the state not checked | cloudbk-auth.test.ts › the web path › each flow's state is new, from the random source, and an answer must carry that one (Q20) |
| A14 | the redirect's origin not checked | cloudbk-auth.test.ts › the web path › refuses another path at the extension's own redirect origin (Q14), and keeps nothing |
| A15 | the scope not checked | cloudbk-auth.test.ts › the web path › refuses no drive.file in the scope, and keeps nothing |
| A16 | no client ID, and chrome.identity is called anyway | cloudbk-auth.test.ts › nothing without a client or the permission › with no client ID every call is not_configured, and chrome.identity is not touched |
| T1 | transport: any URL sent | cloudbk-transport.test.ts › where it goes › refuses http://www.googleapis.com/drive/v3/files before anything is sent |
| T2 | transport: redirects followed | cloudbk-transport.test.ts › the revocation › posts the token in the body to Google's revocation URL, and never puts it in the URL |
| T3 | transport: cookies sent | cloudbk-transport.test.ts › the revocation › posts the token in the body to Google's revocation URL, and never puts it in the URL |
| T4 | transport: the revocation puts the token in the URL | cloudbk-auth-rules.test.ts › the sign-in's call sites › no URL is built with a token in it |
| T5 | transport: a failure carries fetch's own error (the URL, the headers) | cloudbk-transport.test.ts › failures carry nothing › no answer, a redirect refused, a timeout: GoogleNetworkError, with no URL, header or token |
| T6 | transport: no time limit | cloudbk-transport.test.ts › failures carry nothing › a request that takes too long is aborted |
| W1 | worker end: a reply holds the token | cloudbk-devcloud.test.ts › the checks › a token with no window, from the worker; a renewal on request; disconnect revokes through the worker's transport |
| W2 | worker end: any page of the extension answered | autofill-pre-sender.test.ts › surfaceOf: who sent it, by URL, origin and tab › the developer cloud page (CLOUDBK patch 3) is a surface in the dev build only, sends no row's type, and its one message is taken from it alone |
| W3 | worker end: the page known as a sender in every build | autofill-pre-sender.test.ts › surfaceOf: who sent it, by URL, origin and tab › each surface is recognised by its exact path, with any query or fragment, an upper-case scheme, and a tab of ours |
| W4 | worker end: the page and its message taken in every build (both gates off) | autofill-pre-sender.test.ts › surfaceOf: who sent it, by URL, origin and tab › each surface is recognised by its exact path, with any query or fragment, an upper-case scheme, and a tab of ours |
| T7 | transport: a file's deletion not allowed (the latest-copy deletions never reach Drive) | cloudbk-transport.test.ts › where it goes › sends Drive's deletions (the latest copy only: revisions and earlier files, for good), with no body |
| W5 | worker end: the rewrite check deletes no older revision | cloudbk-devcloud.test.ts › the checks › upload, list, compare, overwrite: each against Drive, and the rule refusing a writer with the old head |
| Q14 | (the reviewer's) redirect: the path not checked (origin only) | cloudbk-auth.test.ts › the web path › refuses another path at the extension's own redirect origin (Q14), and keeps nothing |
| Q20 | (the reviewer's) the state is a constant | cloudbk-auth.test.ts › the web path › each flow's state is new, from the random source, and an answer must carry that one (Q20) |
| AP1 | P3-01: the account not checked before an upload | cloudbk-remote.test.ts › the account a backup is pinned to (review r3, P3-01) › a token of another Google account writes nothing: wrong_account, whose status is reconnect |
| AP2 | P3-01: Drive's id for the account not read (everything pins to nothing) | cloudbk-drive.test.ts › the calls › names the account, with Drive's own id for it (the account pin, P3-01) |
| AP3 | P3-01: the silent renewal names no account | cloudbk-auth.test.ts › the web path › the silent renewal names the account recorded at connect (login_hint), and only the renewal (P3-01) |
| AP4 | P3-01: another account's token shown as a passing error | cloudbk-remote.test.ts › the account a backup is pinned to (review r3, P3-01) › a token of another Google account writes nothing: wrong_account, whose status is reconnect |
| RV1 | P3-02: disconnect revokes no token within its renewal margin (r2) | cloudbk-auth.test.ts › where a token never is › disconnect revokes a web token whatever is left of its lifetime, minutes or none (P3-02) |
| DC1 | P3-03: the page's test file made as a backup (a restore would list it) | cloudbk-devcloud.test.ts › the checks › the page's files are its own: no restore lists them, and the page lists no backup (P3-03) |
| DC2 | P3-03: the listing's kind ignored (backups and test files together) | cloudbk-devcloud.test.ts › the checks › the page's files are its own: no restore lists them, and the page lists no backup (P3-03) |
| DC3 | P3-03: the page lists the backups, not its own files | cloudbk-devcloud.test.ts › the checks › the page's files are its own: no restore lists them, and the page lists no backup (P3-03) |
| EP1 | R2-05: the allowlist ignores the method | cloudbk-transport.test.ts › where it goes › refuses DELETE about (a method an endpoint does not have): only the endpoints th |
| EP2 | R2-05: Drive's words (trash, generateIds) taken as ids | cloudbk-transport.test.ts › where it goes › refuses DELETE files/trash (emptying the trash): only the endpoints the backup c |
| EP3 | R2-05: any path under Drive's roots taken (r2) | cloudbk-transport.test.ts › where it goes › refuses DELETE about (a method an endpoint does not have): only the endpoints th |
| EP4 | R2-05: one revision's metadata allowed (an endpoint the backup never calls) | cloudbk-transport.test.ts › where it goes › refuses GET files/fileAbc123/revisions/0Brev1 (one revision's metadata (never re |

### 5.8 Sizes and gates (patch 3)

- Source: `google-auth.ts` 362 lines (258 of code), `google-transport.ts` 182 (136), `devcloud-worker.ts` 155 (124),
  `devcloud/main.ts` 117 (84), `devcloud/index.html` 22, `scripts/google-oauth.mjs` 43; tests 952 lines in four files.
- Builds: the prod build's every file is byte for byte the patch 2 r3 build's (popup 57,116 of 61,440 B gz, side panel
  59,349 of 63,488; no budget changed); the e2e build's likewise; the dev build's worker grows by the page's worker end,
  the auth module and the transport.

On the tree of the three patches on `2e260d0` (patches 1 and 2 r3, patch 3 r2), 2026-10-31, each under `nice -n 19` in
the shared lock: `scripts/messages.py` (no file changes), typecheck, build and check (prod: `check-dist (prod) OK`),
`build:e2e` and `check-dist --e2e` (`check-dist (e2e) OK`), `build:dev` and `check-dist --dev` (`check-dist (dev) OK`),
format:check, notices:check; `dist/` and `dist-e2e/` compared with patch 2 r3's, file by file: the same (the first run
found the allowlist's RegExps in the prod and e2e workers; they are built on first use since); and the targeted run of
the ten `cloudbk-*` files with `source-rules`, `m5-source-rules`, `autofill-pre-source-rules` and `autofill-pre-sender`
(14 files, 362 tests, all passed). On the repository's `4b2ec0e` with the three patches (each applies with no offset and no fuzz), the final tree: the
same gates, all passing (prod: popup 57,482 of 61,440 B gz and side panel 59,708 of 63,488, the numbers of `4b2ec0e`
itself; `dist/` and `dist-e2e/` byte for byte those of `4b2ec0e` built alone), the same 14 files (362 tests, all
passed), and **the full unit suite once**, `npx vitest run --maxWorkers=2`: 309 files, 4,930 passed, 4 expected failures
and 1 skipped, which are the suite's own markers, none of them CLOUDBK's; 1,133 s at `nice -n 19`. The smoke run of §5.6 was made on r1 and not repeated: the page changed
only in what the unit tests cover.

## 6. Patch 4: the worker

### 6.1 When it runs, and what one run does (`src/platform/cloud-worker.ts`)

- **A change** is a write of the store's pointer (`sk_active`), from whichever context committed: the worker's own
  `storage.local.onChanged` listener (`watchVault`) reads only the key's name. While backup is on, each change re-arms one
  alarm, `sk-cloud-soon`, 30 s ahead (`SOON_MS`; 5 s in the e2e build), and `sk_cloud_state.pendingSince` keeps the first
  change's time. A commit in a page reaches the worker this way with no message of its own.
- **One run** reads the configuration, loads the store with no key (`VaultStore.load()`, which judges the generation by
  its checksum), reads the configuration again (a load that recovered an older copy has marked the link by then:
  `cloud-mark.ts`), and calls `runBackup` with the recorded account, the merged list, the purge flag and `persist`,
  which saves each link it is handed under the records' lock (`webLock("sixkey-cloud")`, the store's recovery hook's
  too), keeping a recovery mark set meanwhile. A locked vault, "lock every time", a restart: all the same, since nothing
  here needs the key. An empty store uploads nothing; a store that cannot be read is "unreadable".
- **A token Drive refuses** (401) is dropped (Chrome's cache, or the session's record) and the run tried once more; a
  second refusal is "reconnect".
- **Retries**: after a failure, `sk-cloud-retry` 1, 5 and 30 minutes on; a fourth failure in a row waits for the
  routine. An error no retry fixes (`status.ts` `stops`: reconnect, full, too large, forbidden, no password,
  unreadable) arms none. A deletion still owed after an upload that went through (`pruneDue`, `prunes`) is retried with
  the same delays. A success clears the count and the alarm.
- **The routine** (the worker's six-hourly alarm and every start): a run when none ran for a day (`DAILY_MS`, the daily
  check: a deleted file, a revoked grant), or when changes wait and neither alarm is armed (an alarm lost).
- **One run at a time**: a run asked for during another is one more after it; a change during a run keeps its own time
  as `pendingSince` after it.
- **Turning off** runs once more first if backup was on (S3), then clears both alarms; the link stays for a later "on".

### 6.2 The records (`src/platform/cloud-config.ts`, `cloud-mark.ts`)

`sk_cloud_cfg` `{v, on, via, opens, account, link, merged, purged, mismatch}` and `sk_cloud_state` `{v, lastOk, err,
errSince, pendingSince, retries, lastRun}` (CLOUD-BACKUP §3.4), both read strictly: a configuration that does not check
out is that of a backup never set up (off, no account, no link), and a damaged link, merged list or mismatch is dropped
alone (no link: the next upload makes a new file, which overwrites nothing). `cloud-mark.ts` is the store's recovery
hook's part, in every context (`runtime-base.ts`, the popup's too, about 90 B gz there): one read and one write of
`sk_cloud_cfg` under the records' lock, setting `link.recovered`; nothing when there is no link.

### 6.3 The account (P3-01; review r3, S5)

`connected(via)`, after a page signed in on `via`: the worker asks `about.get` itself, records `{id, email}` and turns
the backup on; if an account is recorded already and this one is another, nothing changes but `mismatch`, and the page
hears `{ok: false, why: "mismatch"}`. Every run passes the recorded account to `runBackup`, which stops another
account's token before anything is read or written; the worker then records which account it was (`mismatch`) and the
status is "reconnect", with no retry. `switchAccount()` is the second way (CLOUD-BACKUP §2.1): that account recorded,
no link, nothing merged pending, a run; the old account's files stay. The web path's silent renewal names the recorded
address as `login_hint` (`googleSessions`' `hint`); with no address recorded (Drive gave none) it names none.

### 6.4 The network, the manifest and check-dist

- `platform/cloud-google.ts`: one `GoogleTransport` for the worker, and the sign-in (`browserAuth`) built per session:
  `chrome.identity` is there only once the optional permission is granted, which happens in a page after the worker
  started, and a reference taken at start would stay empty. `GoogleAuth.token` checks the client and the permission
  before every token (CLOUD-BACKUP §2.5 "the switch").
- `manifest.base.json`: `identity` among the optional permissions, and the CSP's `connect-src` with Google's two API
  origins; `manifest.e2e.json` and `scripts/build.mjs` keep both out of the e2e build. The store build's manifest changes
  in exactly these two places (§6.8); `oauth2` comes per Google build once `scripts/google-oauth.mjs` names its Chrome
  client (none yet).
- `scripts/build.mjs`: `__CLOUD_FAKE__` (true in the e2e build) and `__DRIVE_ORIGIN__` (Google's, or the fake's) for
  `core/cloud/drive.ts`, so the e2e bundle names no Google URL at all.
- `scripts/check-dist.mjs` (§2.5 of the design): see P4-2 in §0. The worker's size is printed and held at 112 KB gz in the
  minified builds (CLOUD-BACKUP §6.4 said patch 4 sets one): the store build's is 101,086 B (89,649 at `a713703`).
  `https://drive.google.com/drive/folders/` is not allowed yet: patch 5's card opens it.

### 6.5 The e2e build's Drive (`src/platform/cloud-fake.ts`)

Drive's requests as `core/cloud/drive.ts` makes them, answered from one `storage.local` record (`sk_e2e_drive`), at the
origin `sixkey-fake-drive://drive`, with a fixed token: about (each account its own `permissionId`), the listing by
`appProperties`, the folder, the multipart create, get, download, the media update, revisions listed and deleted (never
the head), and the file's deletion; each file in one account's Drive, seen by that account only. The tests set its
`account` to stand for a browser whose Google account changed. It has no `fetch` (the source rule holds it), and
check-dist finds its mark in the e2e worker only.

### 6.6 What waits for patch 5

The card (connect, the two ways after another account, turning off with the `identity` permission given back,
disconnect), `sk-cloud-merged` sent by the page right after the merge commit with that generation's `seq` and `rev`,
`sk_last_backup` set on success, the status line's words, and `https://drive.google.com/drive/folders/` in check-dist.
The worker's messages exist and are tested (§0 P4-8); no shipped page sends them yet.

### 6.7 Tests (patch 4)

| File | What |
|---|---|
| `test/unit/cloudbk-worker.test.ts` (new, 34) | over the fake Drive and real vaults: the debounce (30 s, re-armed, the first change's time), the alarm names, the vault's watch; what a run uploads (a locked vault through a real `VaultStore`; empty; unreadable; one at a time; persist before the deletions; a change during a run); retries (1, 5, 30 minutes, then none; stopping errors; owed deletions; 401); the daily check; the account (connect, every run, the two ways, no address, a failed connect); the merged list and the purge; off; the recovery mark at load and during an upload; and the real `sw.ts` over fake chrome (a pointer write arms 30 s; the backup's alarm runs on the store with no key) |
| `test/unit/cloudbk-wiring.test.ts` (new, 14) | the records read strictly; the recovery mark; the file names by language; Google's sessions built per session; the fake Drive through `runBackup`, `fetchBackups` and `openCloudBackups`, its accounts, and its refusals |
| `test/unit/cloudbk-check-dist.test.ts` (new, 24) | a real store and e2e build, each pristine one passing, and 21 altered copies each failing with its rule's message |
| `test/e2e/cloud-worker.spec.ts` (new, 3) | the real extension with the fake Drive: a change uploads after the debounce and not before (the alarm 5 s after the change's time, nothing at 2 s, then one revision left); a locked vault is uploaded and stays locked; another account's token writes nothing (not even a folder), the recorded account's file is untouched, "reconnect", the mismatch named, no retry |
| existing, updated | `cloudbk-rules`, `-format`, `-restore`, `-remote` (S1–S4, S6, the binding); `m5-source-rules` (fetch in exactly the allowed places; the CSP per flavour); `m5-check-dist` (a third fetch in the worker); `m2-source-rules` (the recovery hook's second line); `autofill-pre-source-rules` (two alarm names, the settings page's purge message, the cloud listener and its gate, the cloud handler table, the pointer watch); `autofill-pre-sender` (six rows, each type's work once, refusals, the cloud channel kept open for the settings page alone); `autofill-pre-storage` (four message listeners); `test/helpers/sw-world.ts` (every answer recorded; `getUILanguage`) |

### 6.8 Mutants (patch 4)

64 mutants of the new code, all killed by an assertion, none by a timeout: D the debounce and the vault's watch, R the
retries, C the daily check, A the account, M the worker's records, merged list, persist, off and recovery mark, K the
records' parsers and the mark, G Google's sessions, F the fake Drive, S the messages and the source rule on `fetch`, B
check-dist's cloud rules and the build's define, X review r3's S1–S4 and S6 in core (X11 is the reviewer's M8 on the new
`withDues`). The first run left four: D5 and G1 failed on a `TypeError`, not an assertion (the tests now assert before
they read), and A4 and X8 survived (the second way now checks that the new account is never asked about the old
account's file; the S3 fork test now fails the owed deletion twice). In that run the budget case of check-dist's test
failed on the unmutated build too (a pseudo-random hex that compressed too well), so B1 to B9 were run again after it
was fixed: all killed. The four and the nine reruns are in the table.

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| D1 | debounce: 3 s instead of 30 | cloudbk-worker.test.ts › in the real worker (src/background/sw.ts) › a write of the store's pointer, and no other key, arms |
| D2 | debounce: each change restarts the waiting time (the first change's time lost) | cloudbk-worker.test.ts › when it runs › a change arms the upload 30 seconds ahead, and each later change moves it: one alarm |
| D3 | debounce: a change arms nothing (on and off swapped) | cloudbk-worker.test.ts › in the real worker (src/background/sw.ts) › a write of the store's pointer, and no other key, arms |
| D4 | debounce: the vault's watch reacts to any key | cloudbk-worker.test.ts › in the real worker (src/background/sw.ts) › a write of the store's pointer, and no other key, arms |
| D5 | the worker does not watch the vault (watchVault not called) | cloudbk-worker.test.ts › in the real worker (src/background/sw.ts) › a write of the store's pointer, and no other key, arms |
| D6 | the worker's alarms do not reach the backup | cloudbk-worker.test.ts › in the real worker (src/background/sw.ts) › the backup's alarm runs the backup on the store as it r |
| D7 | a change during a run is taken as uploaded | cloudbk-worker.test.ts › what a run uploads › a change during a run still waits after it: its time is kept, the run's own is |
| D8 | two runs at once (no single flight) | cloudbk-worker.test.ts › what a run uploads › one run at a time: a run asked for during another starts after it, once |
| R1 | retries: always one minute | cloudbk-worker.test.ts › retries › a failure retries after 1, 5 and 30 minutes, then waits for the routine; a success clears |
| R2 | retries never stop (the fourth failure retried too) | cloudbk-worker.test.ts › retries › a failure retries after 1, 5 and 30 minutes, then waits for the routine; a success clears |
| R3 | an error no retry fixes is retried | cloudbk-worker.test.ts › retries › an error no retry fixes (a full Drive, revoked access) arms no retry: it waits for the us |
| R4 | a success keeps the failure count | cloudbk-worker.test.ts › retries › a deletion still owed after an upload that went through retries too, with the same delays |
| R5 | a deletion still owed after an upload is not retried | cloudbk-worker.test.ts › retries › a deletion still owed after an upload that went through retries too, with the same delays |
| R6 | a 401 is not dropped and tried again | cloudbk-worker.test.ts › retries › a token Drive refuses (401) is dropped and the run tried once more; a second refusal is r |
| C1 | daily check: two days | cloudbk-worker.test.ts › the daily check (the worker's routine) › runs when none ran for a day, changes or not; not sooner |
| C2 | daily check: one tick late (> for >=) | cloudbk-worker.test.ts › the daily check (the worker's routine) › runs when none ran for a day, changes or not; not sooner |
| C3 | a change whose alarm was lost waits for the next day | cloudbk-worker.test.ts › the daily check (the worker's routine) › a change whose alarm was lost runs at the routine; one who |
| A1 | the recorded account is not passed to the run | cloudbk-worker.test.ts › the account (P3-01, review r3 S5) › an account whose address Drive leaves out is recorded by its id |
| A2 | connect with another account switches the backup silently | cloudbk-worker.test.ts › the account (P3-01, review r3 S5) › connect with another account when one is recorded changes nothi |
| A3 | the other account is not recorded as the mismatch | cloudbk-worker.test.ts › the account (P3-01, review r3 S5) › an account whose address Drive leaves out is recorded by its id |
| A4 | switchAccount keeps the old link (writes into the old account's file id) | cloudbk-worker.test.ts › the account (P3-01, review r3 S5) › the second way: the backup moves to the new account, a new file |
| M1 | the merged list consumed whatever generation it is for | cloudbk-worker.test.ts › the merged list (review r3, S2) and the purge › is kept for its generation and consumed by the run |
| M2 | a page's merged list is not kept | cloudbk-worker.test.ts › the merged list (review r3, S2) and the purge › a list is not consumed by a run that failed |
| M3 | the purge event not passed to the run | cloudbk-worker.test.ts › the purge event › an erased account goes to the run as a purge event: this device's earlier files a |
| M4 | persist not wired: nothing saved before the deletions | cloudbk-worker.test.ts › what a run uploads › the link is saved after the upload and before any deletion, and an overwrite n |
| M5 | turning off does not run first | cloudbk-worker.test.ts › off, and the store's recovery mark › turning backup off uploads what waits first, then clears the a |
| M6 | the configuration read before the load (a recovery's mark missed) | cloudbk-worker.test.ts › off, and the store's recovery mark › a load that recovered an older copy marks the link first: the |
| M7 | a recovery mark set during the upload is overwritten | cloudbk-worker.test.ts › off, and the store's recovery mark › a mark set while an upload is in flight is kept: the next run |
| M8 | the purge flag never cleared | cloudbk-worker.test.ts › the merged list (review r3, S2) and the purge › an erased account makes the next upload a purge eve |
| K1 | records: an unknown sign-in path read as Chrome's | cloudbk-wiring.test.ts › the records (cloud-config.ts) › one that does not is the configuration of a backup never set up: of |
| K2 | records: a merged list of any length | cloudbk-wiring.test.ts › the records (cloud-config.ts) › the account and the merged list are read field by field |
| K3 | records: a merged file's vault not checked | cloudbk-wiring.test.ts › the records (cloud-config.ts) › the account and the merged list are read field by field |
| K4 | the recovery mark writes a link where there was none | cloudbk-wiring.test.ts › the store's recovery mark (cloud-mark.ts) › writes nothing when backup was never set up or has no l |
| K5 | the recovery mark outside the lock | cloudbk-wiring.test.ts › the store's recovery mark (cloud-mark.ts) › runs under the lock it is given |
| G1 | Google's sign-in built once, when the worker starts (identity not there yet) | cloudbk-wiring.test.ts › the worker's Google sessions (cloud-google.ts) › the sign-in is built per session: a permission gra |
| G2 | a refused token is not dropped | cloudbk-wiring.test.ts › the worker's Google sessions (cloud-google.ts) › the sign-in is built per session: a permission gra |
| F1 | the fake answers any origin (a real Drive URL included) | cloudbk-wiring.test.ts › the e2e build's in-extension Drive (cloud-fake.ts) › refuses what Drive refuses: another token, ano |
| F2 | the fake shows every account's files | cloudbk-wiring.test.ts › the e2e build's in-extension Drive (cloud-fake.ts) › another account sees none of the first's files |
| F3 | the fake deletes the head revision | cloudbk-wiring.test.ts › the e2e build's in-extension Drive (cloud-fake.ts) › refuses what Drive refuses: another token, ano |
| S1 | the cloud listener takes any sender (no gate) | autofill-pre-sender.test.ts › the service worker (src/background/sw.ts) › every worker message type is ignored from every ex |
| S2 | the popup may turn the backup off and on | autofill-pre-sender.test.ts › the service worker (src/background/sw.ts) › every worker message type is ignored from every ex |
| S3 | the fake Drive's module calls fetch | m5-source-rules.test.ts › M5 source rules › `fetch` in exactly the allowed places: the two transports, once each, built by t |
| S4 | a page imports Google's transport | m5-source-rules.test.ts › M5 source rules › `fetch` in exactly the allowed places: the two transports, once each, built by t |
| B1 | check-dist: Google's origins expected in every build's CSP | cloudbk-check-dist.test.ts › the pristine builds › pass |
| B2 | check-dist: any Google API URL allowed | cloudbk-check-dist.test.ts › the pristine builds › pass |
| B3 | check-dist: identity as a required permission not refused | cloudbk-check-dist.test.ts › the store build's alterations › identity required |
| B4 | check-dist: two fetches allowed in the e2e worker | cloudbk-check-dist.test.ts › the e2e build's alterations › a second fetch in the worker (the Google transport) |
| B5 | check-dist: Google's sign-in page and token record allowed in the e2e build | cloudbk-check-dist.test.ts › the e2e build's alterations › Google's sign-in page named in a page, as a bare host |
| B6 | check-dist: the fake allowed in a Google build | cloudbk-check-dist.test.ts › the store build's alterations › the fake Drive in the store build |
| B7 | check-dist: the worker's budget not held | cloudbk-check-dist.test.ts › the store build's alterations › a worker over its budget (CLOUD-BACKUP §6.4) |
| B8 | check-dist: identity expected only in the dev build (the store build fails) | cloudbk-check-dist.test.ts › the pristine builds › pass |
| B9 | build: the e2e build gets Google's Drive, not the fake | cloudbk-check-dist.test.ts › the e2e build's alterations › a second fetch in the worker (the Google transport) |
| X1 | S2: the merged list's envelope revision not checked | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › the binding itself: a list counts fo |
| X2 | S2: the merged list's generation not checked | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › the binding itself: a list counts fo |
| X3 | S2: the merged list counts under the store's recovery mark | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › the binding itself: a list counts fo |
| X4 | S1: a same-vault earlier file let go once a page has looked | cloudbk-remote.test.ts › what a device deletes of its own at a wrap event (CB-01) › keeps an earlier file nobody merged, and |
| X5 | S3: an overwrite does not name its text first | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › an overwrite whose answer is lost is |
| X6 | S3: any head taken as this device's own overwrite | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a head that is not the overwrite's o |
| X7 | S3: a fork drops the left file's owed revisions | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a file left behind while its older r |
| X8 | S3: an owed deletion that fails again is dropped | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › a fork from another writer's head wh |
| X9 | S4: no retired key ids uploaded | cloudbk-format.test.ts › what is uploaded › leaves the earlier vault keys out (review r2 CB-13): a restore never needs them, |
| X10 | S4: a restore ignores the retired ids | cloudbk-restore.test.ts › the restored keyring (CB-03) › never lands on a key another file names as retired, though the comp |
| X11 | S6 (the reviewer's M8): withDues forgets the revision duty | cloudbk-remote.test.ts › the cleanup a link owes, until it is done (review r3, R2-02) › an owed deletion that fails again in |
| X12 | S3: the owed list unbounded in a link | cloudbk-rules.test.ts › decideWrite › a link keeps other files' owed deletions, at most MAX_PRUNES, the newest, and an overw |

The reviewer's eleven r3 probes (`review-r3/zz-review-r3-probes.test.ts`, copied in for one run and removed) on patch
4: the six "fixed:" pass except "R2-02: an event met by the worker alone keeps the duty; a later page merge deletes the
file", whose page merge is a plain list where patch 4 asks for one bound to its generation (S2; the same case with a
bound list is in remote's tests); of the five "now:", four now fail (S1, S2, S4, and S3's fork: the old file's owed
revisions are deleted), and S3's lost answer still forks there because that harness passes no `persist`, without which
nothing can be saved before the request (with it: remote's "an overwrite whose answer is lost is recognised …").

### 6.9 Sizes and gates (patch 4)

- Source: `cloud-worker.ts` 315 lines, `cloud-config.ts` 145, `cloud-fake.ts` 163, `cloud-google.ts` 28,
  `cloud-mark.ts` 20, `cloud-names.ts` 19; tests: `cloudbk-worker.test.ts` 723 lines, `cloudbk-wiring.test.ts` 319,
  `cloudbk-check-dist.test.ts` 259, `test/e2e/cloud-worker.spec.ts` 110.
- Store build against `a713703`: popup 57,569 of 61,440 B gz (57,482 before: +87, the store's recovery hook's mark),
  side panel 59,798 of 63,488 (59,708: +90); the settings page's static load 122,948 B gz (122,828: +120; scripts and
  stylesheets its HTML names, gzip 6) and its catalogs unchanged (every line of check-dist's "settings" output the
  same); `sw.js` 101,086 B gz (89,649: +11,437), held at 114,688. No budget changed or loosened; the worker's is new.
- The store build's manifest changes in exactly two places: `content_security_policy.extension_pages`'s `connect-src`
  gains `https://www.googleapis.com https://oauth2.googleapis.com` after `https://api.sixkey.app`, and
  `optional_permissions` gains `identity` (last). No `oauth2` key (no client yet), no host permission, nothing required.
- The e2e build names no Google API or sign-in host in any file (`googleapis.com`, `accounts.google.com`: none); the
  only `google.com` in it is the test plugin catalog's Chrome Web Store links (`chromewebstore.google.com`), there
  before patch 4 and never fetched. Its worker carries the fake, and its manifest neither `identity` nor Google in the CSP.

Gates on the patch 4 tree (`a713703` + this patch), 2026-10-31, each under `nice -n 19` in the shared lock:
`scripts/messages.py` (no file changes), typecheck, build and check (`check-dist (prod) OK`), `build:e2e` and
`check-dist --e2e` (`OK`), `build:dev` and `check-dist --dev` (`OK`), format:check, notices:check. The targeted run: the
13 `cloudbk-*` files with the worker's harness users and the source and check-dist rules (29 files, 756 tests; the two
that failed first, m5-sw-wiring's listener count and the budget case's text, fixed and rerun). **The full unit suite once**, `npx vitest run --maxWorkers=2`: 312 files,
5,023 passed, 4 expected failures and 1 skipped (the suite's own markers, none of them CLOUDBK's); 1,145 s at `nice -n
19`. The e2e specs, in a copy whose path has no `/e2e/`, in Playwright's own Chromium, with no
server but the side panel spec's own on a port the system picks: `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2, on the
store build), `sidepanel.spec.ts` (5) and `short-settings.spec.ts` (37): 47 passed.

## 7. Patch 5: the settings pages

### 7.1 The brief, the review of patch 4 (REVIEW-P4.md), and where each is

| # | What | Where | Tests |
|---|---|---|---|
| Card | Settings › Backup's first card, every state of CLOUD-BACKUP §6.2: off (one button), connecting, backed up ("已备份到 Google 云端硬盘 · 3 分钟前"), uploading and waiting, failed and stale, reconnect, another account with the two ways, paused, the errors no retry fixes, not configured; the cost line always on it; the switch; "断开"; the folder's link | `src/options/cloud/model.ts` (cardView: the state from the two records, `identity` and the time), `CloudCard.tsx`, `act.ts` (the worker's messages, the sign-in), `platform/cloud-ask.ts` (`identity` in the click) | cloudbk-pages-dom: "the card's state, as model.ts works it out" (2) and "Settings › Backup's Google Drive card" (19); e2e cloud-pages: connect, auto backup, another account both ways, disconnect |
| Restore | One click "从 Google 云端硬盘恢复" in first run and in Backup (no vault), then the master password or recovery key in one field; the result said honestly ("已恢复 N 个账户", `outdated` with "设置新主密码" there and skippable, `olderKeys`, `notRead`, files the secret does not open, damaged ones); a recovery-key restore is the reset (a new master password, no new recovery key) | `RestoreStep.tsx`, `After.tsx`, `FirstRun.tsx` (mode "cloud"), `Backup.tsx`; `VaultService.prepareRestoredKeys` (the restored keyring and vault key as they are; a new password for a recovery restore; never a keyring with no password wrap) | cloudbk-pages-dom: "the restore from Google Drive (RestoreStep) and its result (CloudAfter)" (8); e2e: "a fresh profile restores from Google Drive with one click and the master password" |
| First run's end | "要不要自动备份到 Google 云端硬盘？[开启] [以后再说]", not in a profile declared shared, not when already on; [开启] asks for `identity` in the click and opens the card connecting (`sk_cloud_go`) | `After.tsx`, `act.ts` (wantConnect, takeConnect) | cloudbk-pages-dom: the offer (2), "connect now" (1) |
| Choose file | A downloaded cloud backup (`sixkey-cloud-backup`) opens with the master password or recovery key in every build, the store build included (no Google): restored through the wizard on a computer with no vault, merged into the vault otherwise. In a build that hides the cloud pages too (the store build from CSB-0 on): first run takes the opened file on to its keys there, its step named as a file's; the end of first run's cloud lines (another key, an outdated password's offer) are not in that build | `file.ts`, `Backup.tsx`, `FirstRun.tsx` | csb0-store-pages-dom (both builds: the master password and the recovery key); e2e store-backup.spec |
| Hidden UI | The store build hides every cloud page (`__CLOUD_UI__`, scripts/google-oauth.mjs cloudUiIn): at patch 5 while its client IDs were placeholders, and from CSB-0 on for good. Since CSB-0 it ships none of the four page chunks (the build drops the settings page's three), not the plugin's store page, none of the elements check-dist lists (the card's, the restore step's, the end of first run's, the popup's, and both "restore from Google Drive" buttons), nothing in the popup or side panel hands over to the card, statically or lazily, and its catalog leaves the cloud entry out | `scripts/build.mjs`, `scripts/check-dist.mjs` | cloudbk-check-dist: "the store build hides the cloud backup (CSB-0) …", "the store build's popup and side panel …", the store build's CSB-0 alterations, "the settings page cannot reach the cloud backup's card" (e2e); csb0-store-pages-dom (first run's button, both builds); e2e store-backup.spec.ts, with the e2e build as its control |
| Contracts | `sk-cloud-merged {seq, rev, files}` after a merge commit; `sk_last_backup` on every run that goes through | `act.ts` mergeOwn (the worker downloads the earlier files, `VaultService.openOwnGenerations` opens those of this vault with a key held here, each merged with importBackup, then the list bound to the generation that holds the merge); `cloud-worker.ts` | cloudbk-pages-dom: "earlier files owed: merged while unlocked …", "… while locked: nothing is asked"; cloudbk-worker: "a run that went through sets the backup reminder's time" |
| A1 | On with no account recorded is reconnect, with no request | `cloud-worker.ts` once | cloudbk-worker "A1: …"; pages-dom: reconnect |
| A2 | The CSP names paths: `https://www.googleapis.com/drive/v3/`, `…/upload/drive/v3/`, `https://oauth2.googleapis.com/revoke` | `manifest.base.json`, `manifest.dev.json`, `scripts/google-oauth.mjs` GOOGLE_API_SOURCES, `check-dist.mjs` | cloudbk-check-dist "connect-src with Google's whole origins instead of its paths"; m5-source-rules |
| A3 | `identity` withdrawn in chrome://extensions: paused, nothing asked of anyone, with what it means at Google; given back, it runs again | `cloud-worker.ts` (granted, permission), `sw.ts` (permissions events), the card | cloudbk-worker "A3: …"; pages-dom "paused …" |
| A4 | Google's window in a page-only module; no interactive call in any build's `sw.js` | `platform/google-connect.ts`, `check-dist.mjs` | cloudbk-auth-rules; cloudbk-check-dist "an interactive sign-in in the worker" |
| A5 | A clean-up that keeps failing is dated (`pruneFailingSince`) and said on the card after a day | `cloud-worker.ts`, `cloud-config.ts`, `model.ts` | cloudbk-worker "A5: …"; pages-dom "a deletion failing for a day …" |
| A6 | The debounce waits at most 5 minutes after the first change (not while failures wait for their retries) | `cloud-worker.ts` changed | cloudbk-worker "A6: …" |
| A7 | The worker's budget 104 KB gz (106,496 B) | `check-dist.mjs` | cloudbk-check-dist "a worker over its budget" |

### 7.2 The wording, as the maintainers settled it (2026-10-31)

The maintainers took the proposed table as it was, but for three lines (ckCostRecovery, ckPaused, ckWrong) and the
quotation marks (“”, as the other Chinese catalogs). The catalog is `cloud` (scripts/i18n/cloudbk.py), 59 keys, budget
3,584 B gz; "已恢复 N 个账户" is the existing `restored`. B: UTF-8 bytes of the text.

| Key | zh_CN | en | B (zh / en) |
|---|---|---|---|
| ckTitle | 自动备份到 Google 云端硬盘 | Automatic backup to Google Drive | 35 / 32 |
| ckBody | 加密后存进你自己的云端硬盘。之后账户有改动就自动备份，换电脑时输主密码就能恢复。 | Encrypted and kept in your own Google Drive. After that, every change is backed up by itself, and on a new computer your master password brings it back. | 120 / 152 |
| ckOn | 备份到 Google 云端硬盘 | Back up to Google Drive | 29 / 23 |
| ckCost | 能用主密码或恢复密钥打开。能进入你 Google 账户的人可以试着猜主密码，主密码越难猜越安全。 | It opens with your master password or recovery key. Anyone who gets into your Google account could try to guess your master password; the harder it is to guess, the safer the backup. | 128 / 182 |
| ckCostRecovery | 只能用恢复密钥打开，能进入你 Google 账户的人没有密码可猜。之前被人下载走的副本仍能用主密码打开；要让它打不开以后的备份，请“更换加密密钥”。 | Only your recovery key opens it, so someone in your Google account has no password to guess. A copy someone downloaded earlier still opens with your master password; to cut it off from later backups, replace the encryption key. | 206 / 227 |
| ckSwitch | 只用恢复密钥打开云端备份 | Open the cloud backup with the recovery key only | 36 / 48 |
| ckSwitchHint | 最好在第一次备份前选好：之后再改，只保护以后上传的备份。 | Best chosen before the first backup: changing it later protects only what is uploaded from then on. | 84 / 99 |
| ckLatest | 云端只留最新的一份，较早的版本会自动删除。 | Only the latest copy is kept in Drive; older versions are deleted. | 63 / 66 |
| ckNotConfigured | 这个版本还没有配置 Google 登录。 | This build has no Google sign-in configured. | 44 / 44 |
| ckConnecting | 正在连接 Google 云端硬盘… | Connecting to Google Drive… | 35 / 29 |
| ckAccount | Google 账户：$1 | Google account: $1 | 18 / 18 |
| ckOk | 已备份到 Google 云端硬盘 · $1 | Backed up to Google Drive · $1 | 38 / 31 |
| ckUploading | 正在备份… | Backing up… | 15 / 13 |
| ckWaiting | 有改动还没备份 · 稍后会自动备份 | Changes not backed up yet · Sixkey backs them up shortly | 46 / 57 |
| ckFailed | 备份没成功：$1 · 会自动重试 | Backup failed: $1 · Sixkey will try again | 39 / 42 |
| ckStale | 已经 $1 天没备份成功：$2 | No successful backup for $1 days: $2 | 33 / 36 |
| ckErrNetwork | 连不上 Google | can't reach Google | 16 / 18 |
| ckErrServer | Google 暂时出错 | Google had a problem | 19 / 20 |
| ckReconnect | 需要重新连接 Google 云端硬盘 | Reconnect Google Drive to keep backing up | 38 / 41 |
| ckReconnectBtn | 重新连接 | Reconnect | 12 / 9 |
| ckFull | Google 云端硬盘空间已满，备份没成功 | Your Google Drive is full; the backup failed | 49 / 44 |
| ckTooLarge | 保险库太大，超过了云端备份一次能传的大小 | The vault is too large for one cloud backup upload | 60 / 50 |
| ckForbidden | Google 不允许 Sixkey 写入云端硬盘（可能是单位管理员的设置） | Google does not let Sixkey write to your Drive (perhaps your organisation's policy) | 81 / 83 |
| ckNoPassword | 设置主密码后才能备份到 Google 云端硬盘 | Set a master password to back up to Google Drive | 53 / 48 |
| ckUnreadable | 这台电脑上的数据读不出来，备份停了 | The data on this computer can't be read; the backup stopped | 51 / 59 |
| ckCleanup | 云端还有较早的版本没删掉，会继续重试 | Older versions are still in Drive; Sixkey keeps trying to delete them | 54 / 69 |
| ckPaused | 备份已暂停：Sixkey 的 Google 登录权限被收回了。 | Backup paused: Sixkey's permission to sign in to Google was withdrawn. | 63 / 70 |
| ckPausedHint | Sixkey 在你的 Google 账户里仍有访问权，断开连接才会撤销。 | Sixkey still has access in your Google account; disconnecting withdraws it. | 78 / 75 |
| ckResume | 继续备份 | Resume backup | 12 / 13 |
| ckMismatch | 现在登录的是另一个 Google 账户（$1）。备份属于 $2。 | Signed in to another Google account ($1). The backup belongs to $2. | 70 / 67 |
| ckMismatchSome | 另一个账户 | another account | 15 / 15 |
| ckBackTo | 重新连接 $1 | Reconnect $1 | 15 / 12 |
| ckMoveTo | 改为备份到 $1 | Back up to $1 instead | 18 / 21 |
| ckMoveHint | 以后的备份存到这个账户，原来账户里的文件会留在那里。 | From now on the backup goes to this account; the files in the other account stay there. | 78 / 87 |
| ckView | 在云端硬盘中查看 | View in Drive | 24 / 13 |
| ckNow | 立即备份 | Back up now | 12 / 11 |
| ckDisconnect | 断开 | Disconnect | 6 / 10 |
| ckDisconnectHint | 撤销 Sixkey 对你 Google 云端硬盘的访问。云端硬盘里的备份文件会留着，你可以自己删。 | Withdraws Sixkey's access to your Google Drive. The backup file stays in your Drive; you can delete it yourself. | 115 / 112 |
| ckDidNotConnect | 没能连接 Google 云端硬盘，请再试一次。 | Couldn't connect to Google Drive. Try again. | 53 / 44 |
| ckRestore | 从 Google 云端硬盘恢复 | Restore from Google Drive | 29 / 25 |
| ckStep | 从云端恢复 | From Google Drive | 15 / 17 |
| ckFinding | 正在查找云端硬盘里的备份… | Looking for your backups in Google Drive… | 39 / 43 |
| ckNone | 这个 Google 账户的云端硬盘里没有 Sixkey 的备份。 | No Sixkey backup in this Google account's Drive. | 64 / 48 |
| ckFound | 在云端硬盘里找到 $1 份备份。输入主密码或恢复密钥打开。 | Found $1 backups in your Google Drive. Type your master password or recovery key to open them. | 79 / 94 |
| ckSecret | 主密码或恢复密钥 | Master password or recovery key | 24 / 31 |
| ckOpen | 打开 | Open | 6 / 4 |
| ckWrong | 打不开云端硬盘里的备份，请检查主密码或恢复密钥。 | That doesn't open the backups in your Drive. Check your master password or recovery key. | 72 / 88 |
| ckOutdated | 另一台电脑上的主密码比你输入的新。可以现在设一个新主密码，并在那台电脑上也改成它。 | The master password on another computer is newer than the one you typed. You can set a new one now, and change that computer's to it too. | 123 / 137 |
| ckSetNew | 设置新主密码 | Set a new master password | 18 / 25 |
| ckLater | 以后再说 | Later | 12 / 5 |
| ckNewSet | 新主密码已设好。 | New master password set. | 24 / 24 |
| ckOlderKeys | 另一份备份用的是旧的加密密钥；请在那台电脑上也更换加密密钥。 | Another backup uses an older encryption key; replace the key on that computer too. | 90 / 82 |
| ckNotRead | 还有 $1 份备份没有读取。 | $1 more backups were not read. | 34 / 30 |
| ckOtherSecret | 还有 $1 份备份用你输入的打不开。 | $1 backups don't open with what you typed. | 46 / 42 |
| ckDamaged | $1 份备份已损坏或来自更新版本的 Sixkey，没有打开。 | $1 backups are damaged or from a newer Sixkey and were not opened. | 70 / 66 |
| ckNeedPassword | 已用恢复密钥打开：接下来请设一个新的主密码。 | Opened with your recovery key: set a new master password next. | 66 / 62 |
| ckFile | 这是 Sixkey 的云端备份。输入主密码或恢复密钥打开。 | A Sixkey cloud backup. Type your master password or recovery key to open it. | 71 / 76 |
| ckOffer | 要不要自动备份到 Google 云端硬盘？ | Back up automatically to Google Drive? | 47 / 38 |
| ckOfferOn | 开启 | Turn on | 6 / 7 |

### 7.3 Decisions (the maintainers, 2026-10-31)

1. The worker's budget: 104 KB gz.
2. One control, "断开": what is owed is done first, then every token revoked and dropped, `identity` given back, the
   account and the link forgotten; the switch kept, the file left in Drive. No separate "stop".
3. The popup's growth (below): one simple attempt, else accepted with the evidence here.
4. The store build hides the cloud pages while its client IDs are placeholders; the chunk files may stay in `dist/`,
   and check-dist holds that no page names them.
5. "选择文件" opens a cloud backup in every build.
6. `sk_cloud_go`, the 60 s handoff, in PRIVACY.md's list.
7. A3 as built.

**The popup's growth (+732 B; the side panel +727 B) with no change of the popup's code.** The store build's popup is
58,301 of 61,440 B gz against d2e3411's 57,569 (the side panel 60,525 against 59,798); the figures below were taken
while bisecting, when it was 58,313. The dev build's source maps of the popup's
statically loaded chunks list the same modules with the same source text before and after; what changed is how
Rolldown splits them: the boot chunk grew (4,238 → 10,329 B gz) and runtime-base shrank (18,908 → 14,004), with more
cross-chunk imports and exports (+612 B raw). Bisected: reverting Backup.tsx, FirstRun.tsx and App.tsx alone restores
57,569; Backup.tsx alone brings back +744; without its dynamic imports of the card and of the file route (both reach
`core/cloud/restore.ts` and its keyring, merge and vault modules, which the popup also loads statically) it is +1 B. The
one simple fix tried, a single dynamic boundary for all of the cloud pages (one `import("./cloud")`), changed nothing
(58,313 again), so it was taken out; manual chunks were not tried (the maintainers: no chunk configuration to keep up).
Accepted.

### 7.4 What is where

- `src/options/cloud/`: `model.ts` (the card's state, the reasons, the time since, the restore's secret), `act.ts` (the
  worker's messages, the sign-in, the listing, the opening, the adoption, the merge), `google.ts` (Google's half, never in
  the e2e build), `CloudCard.tsx`, `RestoreStep.tsx` (with `resultLines`), `After.tsx` (first run's end), `file.ts`
  ("选择文件"). `src/platform/cloud-ask.ts` (`identity` in the click, with no import),
  `src/platform/cloud-go.ts` (the 60 s handoff), `src/platform/google-connect.ts` (A4), `src/ui/cloud-text.ts`.
- The wizard (`FirstRun.tsx`) has a fourth way in, `{mode: "cloud"}`: its first step is the restore's (named "从云端恢复",
  standing where a file's step would), then the new master password only for a recovery restore, then the profile
  question; no recovery code step (the restored one stays). `VaultService.prepareRestoredKeys` and `restoreBackup` write
  it; then the worker adopts the base file (`sk-cloud-restored`).
- The e2e build: the card's sign-in is the fake's (the account offered first is taken as chosen), so the e2e tests run
  every page of it with no network; its pages name nothing of Google's (check-dist), the Drive link included.
- What is not done: a restore over a vault that is unlocked here (Settings › Backup offers the restore only with no
  readable vault; with one, the card backs it up and "选择文件" merges a downloaded copy); notices of §6.2's third row (a
  fork's "改存到…" and "从较早的副本恢复的"), which the card does not say yet.

### 7.5 Tests (patch 5)

| File | What |
|---|---|
| `test/unit/cloudbk-pages-dom.test.ts` (new, 29) | the card's state from the records in its order of precedence, and A5's day; the card in every state (off, connecting, not configured, backed up with when and the account, uploading, waiting, failed for each reason, stale with its days, reconnect, the errors no retry fixes, paused, another account and both ways, no address, the clean-up line, the switch, "connect now", the merge while unlocked and not while locked) with what each button sends and that `identity` is asked in the click; the restore step (found, wrong secret, password, recovery key, none, no answer, no permission yet); the result's lines; the new password offer; the offer and its later |
| `test/unit/cloudbk-service.test.ts` (new, 5) | `prepareRestoredKeys` (a password restore keeps the keyring; a recovery restore is the reset; the refusals) and `openOwnGenerations` (this vault's under the key held, never another vault's, one that does not read, one whose keyring names another vault) |
| `test/e2e/cloud-pages.spec.ts` (new, 5) | the real extension with the fake Drive: connect with one click and back up every change by itself (and `sk_last_backup`); a fresh profile restores with one click and the master password (a wrong one said first; no new password or code; the file adopted); another account, both ways; "断开" |
| existing, updated | `cloudbk-worker` (A1, A3, A5, A6, the reminder; the switch, the listing, the adoption, the earlier files, "断开"), `cloudbk-wiring` (the state's new fields; "断开" revokes at Google, drops the token and gives `identity` back), `cloudbk-auth`, `cloudbk-auth-rules` (the interactive calls in google-connect.ts; the ask in a click), `cloudbk-check-dist` (A2, A4, A7, the hidden pages), `budget-split` (the `cloud` catalog, the service's two members), `autofill-pre-sender`, `autofill-pre-source-rules`, `m5-source-rules`; `own-password` (the two new calls that set a master password, a recovery restore's and the end of first run's, under the same gate: `masterAccepts` right before, with "Use anyway"); `sidepanel-check-dist` (its pad, which was a fixed 3 KB, is now chosen to land the side panel's static part within its budget and the whole over it: the headroom this patch took put the fixed one at the budget exactly) |

### 7.6 Mutants (patch 5)

45 mutants of the new code, all killed by an assertion, none by a timeout: U1 to U12 the card's state and the model, U13
to U20 the card's buttons, U21 to U24 the handoff and the merge, U25 to U32 the restore and first run's end, U33 to U35
the service, U36 to U42 the worker's A1, A3, A5, A6 and patch 5's calls, U43 to U45 check-dist's new rules. The first run
left three alive: U6 (the stale days rounded up: the tests used whole days), U35 (another vault's earlier file opened:
the test's file was under another key too) and U42 (the adoption at counter 0: the test compared the fake's live
revision list with itself); each test was sharpened, and all 45 were run again on the final tree.

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| U1 | another account's token not said (no mismatch state) | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › another Google account: the two ways, named; moving asks |
| U2 | a mismatch record of the same account taken as another account | cloudbk-pages-dom.test.ts › the card's state, as model.ts works it out › each state from the records, in its order of preced |
| U3 | paused only when the permission is missing now, not when the worker found it so | cloudbk-pages-dom.test.ts › the card's state, as model.ts works it out › each state from the records, in its order of preced |
| U4 | A1: on with no account shown as backed up | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › reconnect (a refused token, or on with no account): its |
| U5 | reconnect shown as an error no retry fixes | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › reconnect (a refused token, or on with no account): its |
| U6 | stale: the days rounded up | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › failed: the reason, and that it is retried; stale: the d |
| U7 | uploading said as waiting | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › uploading, waiting: their lines |
| U8 | A5: the clean-up line a moment later than a day | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › a deletion failing for a day is said beside the state |
| U9 | A5: the clean-up line while the backup is off | cloudbk-pages-dom.test.ts › the card's state, as model.ts works it out › a deletion that keeps failing is said after a day, |
| U10 | a network failure said as Google's | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › failed: the reason, and that it is retried; stale: the d |
| U11 | the time since: minutes miscounted | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › backed up: when, which account, back up now, disconnect, |
| U12 | a recovery key typed is taken as a password | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the recovery key in th |
| U13 | the cost line also on a build with no client | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › a build with no Google client: not configured, and nothi |
| U14 | a click connects without asking for identity first | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › paused (identity withdrawn): what it means at Google, an |
| U15 | reconnect does not offer the recorded account (Chrome's own sign-in again) | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › reconnect (a refused token, or on with no account): its |
| U16 | moving the backup sends a connect, not the switch | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › another Google account: the two ways, named; moving asks |
| U17 | the switch sends the wrong way round | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › the switch: sent to the worker; on, the card says what i |
| U18 | earlier files merged while locked | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › earlier files owed while locked: nothing is asked (the m |
| U19 | earlier files merged again on every change | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › earlier files owed: merged while unlocked, then the work |
| U20 | the Drive link in the e2e build too (no Google there) | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › backed up: when, which account, back up now, disconnect, |
| U21 | connect-now taken after two minutes | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › a click elsewhere left "connect now" (the popup, first r |
| U22 | connect-now not taken away (a later visit connects again) | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › a click elsewhere left "connect now" (the popup, first r |
| U23 | the merged list bound to the next generation | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › earlier files owed: merged while unlocked, then the work |
| U24 | a file no key here opens is listed as merged | cloudbk-pages-dom.test.ts › Settings › Backup's Google Drive card › earlier files owed: merged while unlocked, then the work |
| U25 | the restore lists without the click's permission | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › without the click's pe |
| U26 | a wrong secret not said | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › lists at once after th |
| U27 | the damaged count leaves out the rejected files | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the end of first run: |
| U28 | every skipped file said as one the secret does not open | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the result's lines: an |
| U29 | the new-password offer without outdated | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the end of first run: |
| U30 | the offer in a profile declared shared | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the offer: in a profil |
| U31 | the offer while the backup is on | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the offer's later: gon |
| U32 | the offer's button leaves no connect-now | cloudbk-pages-dom.test.ts › the restore from Google Drive (RestoreStep) and its result (CloudAfter) › the offer: in a profil |
| U33 | a restored keyring with no password wrap written | cloudbk-service.test.ts › the keys of a restore from the cloud (prepareRestoredKeys) › refused: a keyring with no password a |
| U34 | a vault key that is not the keyring's taken | cloudbk-service.test.ts › the keys of a restore from the cloud (prepareRestoredKeys) › refused: a keyring with no password a |
| U35 | another vault's earlier file opened for the merge | cloudbk-service.test.ts › this vault's earlier files, opened for a merge (openOwnGenerations) › opens this vault's generatio |
| U36 | A6: no ceiling on the debounce | cloudbk-worker.test.ts › patch 5: the review's A1, A3, A5, A6, and the reminder › A6: changes that keep coming wait at most |
| U37 | A5: the clean-up's failure dated anew each run | cloudbk-worker.test.ts › patch 5: the review's A1, A3, A5, A6, and the reminder › A5: a deletion that keeps failing is dated |
| U38 | A3: a run without the permission goes on | cloudbk-worker.test.ts › patch 5: the review's A1, A3, A5, A6, and the reminder › A3: without the identity permission a run |
| U39 | A1: on with no account runs | cloudbk-worker.test.ts › patch 5: the review's A1, A3, A5, A6, and the reminder › A1: on with no account recorded runs nothi |
| U40 | the reminder's time not set | cloudbk-worker.test.ts › patch 5: the review's A1, A3, A5, A6, and the reminder › a run that went through sets the backup re |
| U41 | 断开 does not revoke (the session's disconnect not called) | cloudbk-worker.test.ts › patch 5: what the pages ask of the worker › 断开: what is owed is done first, then the session's disc |
| U42 | a restore's adoption at counter 0 | cloudbk-worker.test.ts › patch 5: what the pages ask of the worker › a restore's adoption: the account recorded, the file co |
| U43 | check-dist: an interactive sign-in allowed in the worker | cloudbk-check-dist.test.ts › the store build's alterations › an interactive sign-in in the worker (review P4, A4) |
| U44 | check-dist: the hidden card reachable | cloudbk-check-dist.test.ts › the store build's alterations › a page can load the cloud backup's card while the build hides i |
| U45 | check-dist: the worker's budget back to 112 KB | cloudbk-check-dist.test.ts › the store build's alterations › a worker over its budget (CLOUD-BACKUP §6.4) |

### 7.7 Sizes and gates (patch 5)

- Source: `options/cloud/` 7 files, 761 lines (`CloudCard.tsx` 232, `act.ts` 148, `RestoreStep.tsx` 121, `After.tsx`
  116, `model.ts` 112, `google.ts` 18, `file.ts` 14), `ui.ts`; `platform/google-connect.ts` 50, `cloud-ask.ts` 11,
  `cloud-go.ts` 20; `ui/cloud-text.ts` 16; the fragment `scripts/i18n/cloudbk.py`; tests 614 + 98 lines (unit) and 141
  (e2e).
- Store build against d2e3411 (check-dist's numbers; the settings page's static load is scripts and stylesheets its HTML
  names, gzip 6):

  | | d2e3411 | patch 5 | limit |
  |---|---|---|---|
  | popup | 57,569 | 58,301 (+732, §7.3) | 61,440 |
  | side panel | 59,798 | 60,525 (+727) | 63,488 |
  | settings page, static load | 122,948 | 125,086 (+2,138) | none |
  | settings page text loaded together | (every line the same) | (every line the same) | 12,288 |
  | `sw.js` | 101,086 | 102,268 (+1,182) | 106,496 (A7) |

  The settings page's static load grows by the wizard's restore mode and Backup's card loading, restore button and file
  route (its entry chunk), the lazy text's helper, and a re-split of the chunks it shares with the popup (as §7.3). The
  card's own state (model.ts) is kept out of it: the build's flag is a module of its own (`options/cloud/ui.ts`).
  The worker grows by the five calls of the pages (listing, the earlier files, the adoption, "断开", the switch) and A1,
  A3, A5, A6, and shrinks by A4's trim. The store build shows none of the pages while its client IDs are placeholders, so
  the e2e build has the numbers of a build that shows them: popup 58,968, side panel 61,222 (of the same limits; the e2e
  build has the Sync section in), `sw.js` 101,579.
- The store build's manifest changes in one place: `connect-src`'s Google entries are the three paths
  (`https://www.googleapis.com/drive/v3/ https://www.googleapis.com/upload/drive/v3/ https://oauth2.googleapis.com/revoke`)
  instead of the two origins. Nothing else.

On the patch 5 tree (d2e3411 + this patch), 2026-10-31, each under `nice -n 19` in the shared lock: `scripts/messages.py`
(its files unchanged by a second run), typecheck, build and check (`check-dist (prod) OK`),
`build:e2e` and `check-dist --e2e` (`OK`; no file names `googleapis.com` or `accounts.google.com`; the only `google.com`
is the test plugin catalog's Chrome Web Store links, there before), `build:dev` and `check-dist --dev` (`OK`), format:check,
notices:check. The targeted run: 44 files, 984 tests, all passed (the `cloudbk-*` files, the source, sender and storage
rules, check-dist's, budget-split, the worker's harness users, import-backup). The e2e specs, in a copy whose path has no
`/e2e/`, with 8787 replaced by the private port 18937 everywhere (the built manifests name 18937 and no 8787), in
Playwright's own Chromium: `cloud-pages.spec.ts` (5), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2),
`sidepanel.spec.ts` (5), `short-settings.spec.ts` (37): 52 passed. **The full unit suite**, `npx vitest run --maxWorkers=2`, on
this tree: 314 files, 5,072 passed, 4 expected failures and 1 skipped (the suite's own markers, none of them CLOUDBK's);
1,196 s. (The first full run, on the tree of both patches, found the two rule tests above, `own-password` and
`sidepanel-check-dist`, and patch 6's popup chunk (§8.3); each was fixed, the gates and e2e runs were made again, and this
is the second full run.)

### 7.8 Round 2: the review of patches 5 and 6 (REVIEW-P5P6.md)

| | The review | What changed | Tests |
|---|---|---|---|
| R5-1 | "断开" in the paused state (`identity` withdrawn): `chrome.identity` is undefined, `disconnect()` threw before revoking anything (or after the web token, before dropping it), the worker swallowed it and the card said off | `GoogleAuth.api`: an absent `chrome.identity` reads as an object with no calls, so nothing touches it unguarded. `disconnect()` revokes every token it holds, drops them, gives `identity` back, and answers whether every grant was withdrawn: false when Google did not confirm a revocation, or when Chrome's own token was out of reach (no `identity`). The worker records that answer as `unrevoked` in `sk_cloud_state` (a connect clears it). The card's "断开" asks for `identity` as its click's first statement (Chrome grants it without a prompt), and tells the worker even when asking fails; an off card with `unrevoked` says so (`ckUnrevoked`), never a plain off. The developer page reports the same answer | `cloudbk-auth` (the reviewer's probe, now passing, and three more), `cloudbk-worker`, `cloudbk-wiring`, `cloudbk-pages-dom`, `cloudbk-devcloud`, e2e `cloud-pages` |
| R5-2 | after a recovery-key restore whose key was renewed on another computer (`needsPassword` and `outdated`), first run's end offered the master-password form, with the recovery key as the old password | `After.tsx`: the form after a password restore only; after a recovery-key restore, one line (`ckOutdatedKey`) | `cloudbk-pages-dom` (the reviewer's case, through `openCloudBackups`) |
| B1 | "断开" in the mismatch state revokes the account signed in now, not the recorded one | said plainly: in that state `ckDisconnectWhich` names both, in place of `ckDisconnectHint` | `cloudbk-pages-dom`, e2e |
| B2 | the restore step's `open()` had no catch; a recovery key with a typo was derived as a master password | `act.ts openBackups` reads the recovery key's shape first: a checksum that fails answers "typo" at once, without a file read or a derivation; the restore step and Settings › Backup › "Choose file" say `ckKeyTypo`; anything else is caught and said (`errText`) | `cloudbk-pages-dom` |
| B4 | `ckOutdated`'s last clause | the maintainers' words | (the catalog) |
| B5 | the reviewer's mutant H3 (a connect-now in the future accepted) survived | a test: one 10 s ahead does nothing, and the key is removed | `cloudbk-pages-dom` |

The words (the maintainers gave B4's; the four new keys are mine, for the maintainers to settle). `cloud`: 63 keys,
budget 3,584 B gz.

| Key | zh_CN | en | B (zh / en) |
|---|---|---|---|
| ckOutdated | 另一台电脑上的主密码比你输入的新。可以现在设一个新主密码，并在那台电脑上也改成它。 | The master password on another computer is newer than the one you typed. You can set a new one now, and change that computer's to it too. | 123 / 137 |
| ckOutdatedKey | 你输入的恢复密钥已在另一台电脑上换过，这台电脑以后也用新的那把。 | The recovery key you typed was replaced on another computer. Use the new one here too. | 96 / 86 |
| ckKeyTypo | 这像是恢复密钥，但有字符输错了，请再核对一下。 | That looks like a recovery key, but part of it is mistyped. Check it again. | 69 / 75 |
| ckUnrevoked | Google 没有确认 Sixkey 的访问已撤销。你可以到 Google 账户的安全设置里移除 Sixkey。 | Google didn't confirm that Sixkey's access was withdrawn. You can remove Sixkey in your Google account's security settings. | 108 / 123 |
| ckDisconnectWhich | “断开”只撤销 $1 的访问。$2 的访问，请到那个 Google 账户的安全设置里移除 Sixkey。 | Disconnecting withdraws access for $1 only. For $2, remove Sixkey in that Google account's security settings. | 112 / 109 |

What "断开" still cannot do: on the web path, a grant for which this browser holds no token (the session's record is
gone after a browser restart; the implicit flow keeps no refresh token) has nothing to revoke from here. `identity` is
given back all the same, so Sixkey cannot use that grant again without a click; the grant stays listed in the Google
account until the user removes it. Getting a silent token first only to revoke it would close this; it is left for the
maintainers to decide. (Round 3 does it: §7.9.)

Mutants (round 2, `r2tools/mutants-p56r2.py`, on the tree of both patches): each fix above undone one at a time, 21 in
all (R5-1 twelve, including the developer page's answer; R5-2 two; B1 two; B2 three; R6-1 one, §8.5; B5 the reviewer's
H3). All 21 are killed by an assertion; two (the card's `ckUnrevoked` line and the `ckOutdatedKey` line) first failed on
a TypeError, as their tests read the missing element with `!`, and were killed once the tests read it with `?.`.

Sizes (store build, check-dist's numbers; round 1's in brackets): popup 58,301 (58,301), side panel 60,525 (60,525),
settings page static load 125,100 (125,086), `sw.js` 102,367 (102,268: the answer of "断开" and its record); the
`cloud` text 1,944 B gz in zh_CN (en 1,730) of 3,584, a vault's page with it 12,933 of 15,360. The e2e build's
`sw.js` 101,638 (101,579). The catalogs `scripts/messages.py` writes are deterministic: made twice from nothing (no
`catalogs/`, no `_locales/`) under two hash seeds, they are byte for byte the same, and the same as the tree's.

On the patch 5 tree of round 2 (d2e3411 + P5-r2), 2026-10-31, each under `nice -n 19` in the shared lock: format,
`scripts/messages.py` (unchanged by a second run), typecheck, build and check (`check-dist (prod) OK`), `build:e2e` and
`check-dist --e2e` (`OK`; the only Google host in it is the test plugin catalog's Chrome Web Store links, as before),
`build:dev` and `check-dist --dev` (`OK`), format:check, notices:check. Targeted: 56 files, 1,303 tests, all passed. The
e2e specs in a copy whose path has no `/e2e/`, with 8787 replaced by the private port 18937, in Playwright's own
Chromium: `cloud-pages.spec.ts` (5), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 10 passed. The reviewer's probes
(`review-p56/zz-review-p56-probes.test.ts`, which assert the behaviour the review found) fail on this tree where they
describe the three findings, and the fourth (a restore never replaces a vault that reads) still passes.

### 7.9 Round 3: the recheck (REVIEW-P5P6-r2.md)

| | The recheck | What changed | Tests |
|---|---|---|---|
| R2-1 | round 2's B2 shortcut refused a right master password shaped like a recovery key as a "typo" and never tried it: about 1 in 226 of Sixkey's own five-word passphrases (28 letters, no "u"), e.g. `ablaze-abroad-accent-abide-acorn` | `act.ts openBackups`: the shape orders the tries and words the refusal only. A key whose checksum holds is tried as the recovery key, then as the master password; one whose checksum fails is tried as the master password, and only if that fails too is it "typo" (`ckKeyTypo`); anything else is the master password. A real typo costs one derivation again | `cloudbk-pages-dom`: the reviewer's passphrase opens in the restore step and in Settings › Backup › "Choose file"; a master password that is a whole recovery key (another key's) opens; a mistyped key is still `ckKeyTypo`, in both places |
| R2-2 | "断开" answered done when the path in use got no token at all (the web path after a browser restart; Chrome's sign-in that gives none) | `GoogleAuth.disconnect(revoke, { via, ours })`: done only when a token on the path in use (the worker's cfg.via, passed by its session) was revoked and Google confirmed it. With none held there, one silent token on that path (the recorded account's hint, as a backup asks), checked with Drive (`pinAccount`) against the recorded account the worker passes, then revoked; another account's token is revoked but counts for nothing, as a silent failure does. The other path's missing token does not matter; its held token Google did not confirm does. Without `via` (the developer page): done only when something was revoked | `cloudbk-auth` (the reviewer's probes, now answering false, and eight more cases), `cloudbk-wiring` (the session: the silent token's account asked of Drive, then revoked; another account's; a silent flow that fails), `cloudbk-worker` (the account passed) |
| B6 | `ckUnrevoked` said "Google did not confirm" where Google was never asked | the maintainers' words, with Sixkey as the subject | (the catalog) |
| B7 | the warning stayed until the next connect | "我已移除" beside it: a new message, `sk-cloud-removed` (settings page to worker), and the worker's `removed()` clears the flag and nothing else | `cloudbk-worker`, `cloudbk-pages-dom`, `autofill-pre-sender` |
| B8 | after "断开" in the mismatch state the card said plain off, though the recorded account's grant stands | recorded as `unrevoked`, and answered not done | `cloudbk-worker` |
| B9 | the developer page's worker built its sign-in once, at start: `identity` granted later was not seen | built for each request, as the store worker's sessions are | `cloudbk-devcloud` |
| B10 | the reviewer's T3 (Choose file's typo said as `ckWrong`) survived | Settings › Backup › "Choose file" drawn with a cloud backup chosen: a mistyped key says `ckKeyTypo`, a wrong secret `ckWrong`, the reviewer's passphrase opens | `cloudbk-pages-dom` |

The words: `ckUnrevoked` changed and one key added (`cloud`: 64 keys).

| Key | zh_CN | en | B (zh / en) |
|---|---|---|---|
| ckUnrevoked | Sixkey 无法确认它在你 Google 账户里的访问已撤销。你可以到 Google 账户的安全设置里移除 Sixkey。 | Sixkey couldn't confirm that its access to your Google account was withdrawn. You can remove Sixkey in your Google account's security settings. | 126 / 143 |
| ckRemoved | 我已移除 | I removed it | 12 / 12 |

§7.8's note on what "断开" could not do is answered by R2-2: the web path's grant with no token held is now reached by a
silent token, or said to stand.

Mutants (round 3, `r2tools/mutants-p56r3.py`, on the tree of both patches): each fix above undone one at a time, 20 in
all (R2-1 four, R2-2 ten, B7 two, B8 two, B9 one, B10 the reviewer's T3). All 20 are killed by an assertion.

Sizes (store build, check-dist's numbers; round 2's in brackets): popup 58,301 (58,301), side panel 60,525 (60,525),
settings page static load 125,104 (125,100), `sw.js` 102,634 (102,367: the silent token's step, its account's check,
"我已移除"); the `cloud` text 1,969 B gz in zh_CN (en 1,744) of 3,584, a vault's page with it 12,944 of 15,360. The e2e
build's `sw.js` 101,705 (101,638).

On the patch 5 tree of round 3 (d2e3411 + P5-r3), 2026-10-31, each under `nice -n 19` in the shared lock: format,
`scripts/messages.py` (unchanged by a second run), typecheck, the three flavours built and checked (`OK`; the e2e
build's only Google host is the test plugin catalog's Chrome Web Store links, as before), format:check, notices:check.
Targeted: 56 files, 1,318 tests, all passed. The e2e specs in the port-switched copy (18937, no 8787):
`cloud-pages.spec.ts` (5), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 10 passed. The recheck's probes
(`review-p56r2/zz-review-p56r2-probes.test.ts`, which assert what the recheck found) fail on this tree where they describe
R2-1 and R2-2 (three), and the other two (the word list's odds; an expired web token still sent to be revoked) pass.

### 7.10 Round 4: the third recheck (REVIEW-P5P6-r3.md)

| | The recheck | What changed | Tests |
|---|---|---|---|
| R3-1 | "断开" decided with the record read before its own run: when that run found another account (the browser's account changed, unnoticed until then), B8 did not apply, and "断开" answered done while the recorded account's grant stood | the worker reads the record again after the run, and only then works out the mismatch and what it tells the session | `cloudbk-worker`: the reviewer's case (connected as Alice, Chrome's account now Bob's: not done, `unrevoked`), the session told both accounts |
| C2 | a held token was revoked without its account asked, and a silent token of another account was revoked too: that account's grant may serve its own backups elsewhere | `GoogleAuth.disconnect(revoke, { via, whose, recorded, named })`: every token's account is asked of Drive first (`pinAccount`); the recorded account's are revoked and count; in the mismatch state the account the card named (ckDisconnectWhich) is revoked too, as the card said, and counts for nothing; any other, or one Drive cannot place, is dropped from the cache and never revoked. The worker passes the named account (cfg.mismatch) in the mismatch state | `cloudbk-auth` (the reviewer's probe, now dropping Bob's token unrevoked and answering false; Drive offline; the mismatch state's named account), `cloudbk-wiring` (the session asks Drive, revokes Alice's, drops Bob's, revokes Bob's where the card named him) |
| C3 | no "under way" while "断开" waits on Google (seconds): a second click started a second "断开", which found nothing to revoke and said `ckUnrevoked` | while it runs every action of the card is disabled (断开, 立即备份, the switch, the two ways, the way back, 我已移除), and a second click starts nothing | `cloudbk-pages-dom` |
| C4 | revoking one token withdraws the whole grant only within one Google Cloud project | stated: CLOUD-BACKUP §7.1 item 4 and §7.3, §5.1 above, `scripts/google-oauth.mjs`; the owner's tutorial (GOOGLE-CLOUD-SETUP.zh.md, step 6, outside the repository) | (docs) |
| C1 | a recovery key typed full-width (a Chinese IME in 全角) was not read | a patch of its own, independent of CLOUDBK: `NFKC-RK.patch` (`normalizeCrockford` reads NFKC first, as pin.ts reads a PIN), with its tests and mutants | `nfkc-codes.test.ts` (in that patch) |

No string changed in this round.

Mutants (round 4, `r2tools/mutants-p56r4.py`, on the tree of both patches): each fix above undone one at a time, 18 in
all (R3-1 two, C2 seven, C3 nine). All 18 are killed by an assertion.

Sizes (store build, check-dist's numbers; round 3's in brackets): popup 58,301 (58,301), side panel 60,525 (60,525),
settings page static load 125,100 (125,104), `sw.js` 102,759 (102,634: every token's account asked, the record read
again). The e2e build's `sw.js` 101,727 (101,705).

On the patch 5 tree of round 4 (d2e3411 + P5-r4), 2026-10-31, each under `nice -n 19` in the shared lock: format,
`scripts/messages.py` (unchanged by a second run), typecheck, the three flavours built and checked (`OK`; the e2e
build's only Google host is the test plugin catalog's Chrome Web Store links, as before), format:check, notices:check.
Targeted: 56 files, 1,323 tests, all passed (the first targeted run found the identity rule's test, `cloudbk-auth-rules`,
refusing C3's guard before `askIdentity()`: the rule now lets a click leave first when one is under way, with nothing
awaited before the ask, and the run was made again). The e2e specs in the port-switched copy (18937, no 8787):
`cloud-pages.spec.ts` (5), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 10 passed. The recheck's probes
(`review-p56r3/`) fail where they describe R3-1, C2 and the full-width key (the last with NFKC-RK, on the tree of all
three), and the control (a run alone records the other account) passes.

### 7.11 Round 5: the fourth recheck (REVIEW-P5P6-r4.md)

| | The recheck | What changed | Tests |
|---|---|---|---|
| R4-1 | R3-1's second read of the record decided the account the card had named: when "断开"'s own run found Bob (the browser's account changed, unnoticed until then), Bob counted as named and his grant was revoked, though the card never named him | the account named is the one in the record the card showed when the user clicked, read before "断开"'s own run; the second read still gives the recorded account and the path. A third account met by that run (Carol, when the card named Bob) is only dropped | `cloudbk-worker`: the R3-1 case now tells the session no named account and revokes nothing of Bob's; the card naming Bob and the run meeting Carol |
| D1 | B8's "the mismatch state is never done" made a false warning where the recorded account's grant was withdrawn after all (the web path's silent token of Alice's) | dropped: `unrevoked` is exactly "the recorded account's grant was not confirmed withdrawn" (C2's answer), in the mismatch state too | `cloudbk-worker`: the mismatch state with Alice's grant withdrawn is done, nothing said; with only Bob's revoked, not done |
| D2 | the reviewer's Q10 (the card's guard never lets go) survived | a test: "断开", connected again on the same page, "断开" again | `cloudbk-pages-dom` |

The worker's test harness now answers "断开" as GoogleAuth.disconnect does since C2: the token is the browser's
account's; it is revoked when it is the recorded account's or the named one's, and done only for the recorded
account's. NFKC-RK's second round (D3, D4: the per-code-point check as a test, and TOTP secrets typed full-width) is a
patch of its own, `NFKC-RK-r2.patch`. No string changed in this round.

Mutants (round 5, `r2tools/mutants-p56r5.py`, on the tree of both patches): R4-1 two, D1 two, D2 one (the reviewer's
Q10). All 5 are killed by an assertion.

On the patch 5 tree of round 5 (d2e3411 + P5-r5), 2026-10-31, under `nice -n 19` in the shared lock: format:check,
typecheck, and the targeted tests, 56 files, 1,324 tests, all passed; the gates, the e2e specs and the full unit suite
ran on the tree of all three (§8.8). The recheck's probes (`review-p56r4/`) fail where they describe R4-1 (the session
told Bob was named), and pass where they describe what stays: GoogleAuth revoking the account it is told is named, and
dropping it when none is; NFKC changing no reading.

## 8. Patch 6: the popup and the side panel

### 8.1 What it does

- **The pill.** The header's "本机" (the popup's own) while the backup is off; "已备份" once it is on, its title the card's
  sentence with when ("已备份到 Google 云端硬盘 · 3 分钟前"); "备份已停" in amber when it stopped: an error no retry fixes,
  three days without success with changes waiting, another account's token, on with no account, the permission
  withdrawn (CLOUD-BACKUP §6.2).
- **The footer.** "N 个账户 · 备份出了问题" when it stopped, which opens Settings › Backup; the popup's own line otherwise.
- **The one click** (the amendment of CLOUD-BACKUP §0). With the backup off and the reminder due (no backup for 7 days,
  the popup's own `BACKUP_REMINDER_MS`) in a profile marked as only the user's (§4: never by the popup's nudge in a
  shared one, which keeps the popup's own reminder; REVIEW-P5P6 R6-1, §8.5), the footer's "立即备份" asks for
  `identity` as the click's first statement, leaves "connect now" (`sk_cloud_go`, platform/cloud-go.ts) and opens
  Settings › Backup, where the card connects as it loads. Once the backup is on, every run that goes through sets `sk_last_backup` (patch 5), so the reminder stays away.
- **Where.** `src/popup/main/CloudPop.tsx`, a lazy chunk (the popup's and the side panel's: the panel draws the popup's
  screens), with the lazy `cloud-popup` catalog (`src/ui/cloud-popup-text.ts`); `Main.tsx` loads it on mount in a build
  that shows the cloud backup, and draws its own pill and footer until it is in. A store build whose client IDs are
  placeholders drops it entirely (the import goes with the define; no chunk of it is emitted), and check-dist requires the
  popup's text chunks only where the cloud backup shows, never reachable by the settings page.
- **Its size.** The first version imported `askIdentity` from a module that imported google-auth.ts's
  `requestIdentityPermission`; that alone re-split the popup's chunks (+590 B gz in the e2e build, measured by building
  with and without it). `platform/cloud-ask.ts` now asks Chrome itself and imports nothing; with it the popup grows by
  146 B gz in a build that shows the cloud backup (e2e: 58,968 → 59,114 of 61,440; the side panel 61,222 → 61,368 of
  63,488) and by 70 B in the store build that hides it (58,301 → 58,371; the side panel 60,525 → 60,594).

### 8.2 The wording (the maintainers, 2026-10-31)

| Key | zh_CN | en | B (zh / en) |
|---|---|---|---|
| cpBackedUp | 已备份 | Backed up | 9 / 9 |
| cpBackedUpTitle | 已备份到 Google 云端硬盘 · $1 | Backed up to Google Drive · $1 | 38 / 31 |
| cpStopped | 备份已停 | Backup stopped | 12 / 14 |
| cpProblem | 备份出了问题 | backup problem | 18 / 14 |

`cloud-popup`: 4 keys, 168 B gz (zh_CN), budget 2,048 B. "立即备份" is the popup's own `backupNow`; the time is the
browser's (`Intl.RelativeTimeFormat`).

### 8.3 Tests and mutants (patch 6)

- `test/unit/cloudbk-popup-dom.test.ts` (new, 7): what the popup says from the records, for every reason that stops it
  and every passing state that does not; the pill (off, backed up with when, stopped in amber, redrawn on a change); the
  footer's problem line; the one click (`identity` in the click, "connect now" left, Settings › Backup opened) and when
  there is none (not due; already on).
- `test/e2e/cloud-pages.spec.ts`: "the popup's one click: 立即备份 opens Settings › Backup with the card connecting; then
  the pill says backed up" (and, stopped, the amber pill and the problem line).
- The first full unit run on this tree failed in `afmatch-dom` (15 tests): its stand-in chrome has no `storage.local`,
  and the chunk's watch on the records threw, which unmounted the popup there. The chunk now reads and watches the
  records through a guard, so a failure of this optional part leaves the popup's own pill and footer.
- Updated: `budget-split` (the `cloud-popup` budget), `autofill-pre-source-rules` (the pill's watch on the records),
  `cloudbk-auth-rules` (the popup's click; the ask that imports nothing).

13 mutants of the new code, all killed by an assertion, none by a timeout:

| # | Mutant | Killed by (the first failing test) |
|---|---|---|
| V1 | three days without success not a stop | cloudbk-popup-dom.test.ts › what the popup says, from the records (popCloud) › off; backed up with when; stopped for every r |
| V2 | the permission withdrawn not a stop | cloudbk-popup-dom.test.ts › what the popup says, from the records (popCloud) › off; backed up with when; stopped for every r |
| V3 | on with no account not a stop | cloudbk-popup-dom.test.ts › what the popup says, from the records (popCloud) › off; backed up with when; stopped for every r |
| V4 | another account's token not a stop | cloudbk-popup-dom.test.ts › what the popup says, from the records (popCloud) › off; backed up with when; stopped for every r |
| V5 | an error no retry fixes not a stop | cloudbk-popup-dom.test.ts › the popup's pill and footer › stopped: 备份已停 in amber, and the footer's problem line opens Settin |
| V6 | off read as on | cloudbk-popup-dom.test.ts › the popup's pill and footer › not due, or already on: no one click (the popup's own footer) |
| V7 | the stopped pill not amber | cloudbk-popup-dom.test.ts › the popup's pill and footer › stopped: 备份已停 in amber, and the footer's problem line opens Settin |
| V8 | the pill shown while off (the popup's own gone) | cloudbk-popup-dom.test.ts › the popup's pill and footer › off: the popup's own pill and footer |
| V9 | the time in the pill's title miscounted | cloudbk-popup-dom.test.ts › the popup's pill and footer › backed up: 已备份, its title with when; the footer is the popup's own |
| V10 | the one click without asking for identity first | cloudbk-popup-dom.test.ts › the popup's pill and footer › the one click: off and due, 立即备份 asks for identity in the click, l |
| V11 | the one click leaves no connect-now | cloudbk-popup-dom.test.ts › the popup's pill and footer › the one click: off and due, 立即备份 asks for identity in the click, l |
| V12 | the one click while the backup is on | cloudbk-popup-dom.test.ts › the popup's pill and footer › not due, or already on: no one click (the popup's own footer) |
| V13 | the one click before the reminder is due | cloudbk-popup-dom.test.ts › the popup's pill and footer › not due, or already on: no one click (the popup's own footer) |

### 8.4 Sizes and gates (patch 6)

- Store build against d2e3411 (patch 5's in brackets):

  | | d2e3411 | patches 5 and 6 | limit |
  |---|---|---|---|
  | popup | 57,569 | 58,371 (58,301) | 61,440 |
  | side panel | 59,798 | 60,594 (60,525) | 63,488 |
  | settings page, static load | 122,948 | 125,086 (125,086) | none |
  | settings page text loaded together | (every line the same) | (every line the same) | 12,288 |
  | `sw.js` | 101,086 | 102,268 (102,268) | 106,496 |

  In the e2e build, which shows the cloud backup: popup 59,114 (58,968), side panel 61,368 (61,222), `sw.js` 101,579.
  The manifest: no change from patch 5.
- Gates on the tree of both patches, as patch 5's (§7.7): messages.py (its files unchanged by a second run), typecheck,
  the three builds and their checks (`OK`; the e2e build names no `googleapis.com` or `accounts.google.com`), format:check,
  notices:check. **The full unit suite**: 315 files, 5,079 passed, 4 expected failures and 1 skipped; 1,240 s. The e2e
  specs in the port-switched copy (18937, no 8787): `cloud-pages.spec.ts` (6, the popup's one click among them),
  `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2), `sidepanel.spec.ts` (5), `short-settings.spec.ts` (37): 53 passed.

### 8.5 Round 2: the review (REVIEW-P5P6.md R6-1)

- **R6-1.** The footer's one click showed in a shared, vendor-synced or scripted profile too, where CLOUD-BACKUP §4 turns
  the backup on from the card only, "never by the popup's nudge or the first-run tail" (first run's end already left its
  offer out there). `Main.tsx` now tells the footer the reminder is due only in a profile marked as only the user's
  (`lastBackupOld && profileOf(screen.settings) === "solo"`, as the side panel's button decides); a shared profile keeps
  the popup's own reminder, which opens Settings › Backup and asks Google nothing.
- Its test, `cloudbk-popup-dom.test.ts`: Main drawn over the stand-ins (as `afmatch-dom` draws it) with the footer a
  stand-in that records what Main tells it: due in a solo profile, never due in a shared one, whose own reminder link
  stays. Its mutant (X19: the profile not asked) is killed (§7.8).
- Sizes (store build; round 1's in brackets): popup 58,377 (58,371), side panel 60,600 (60,594), `sw.js` 102,367 (as
  §7.8). In the e2e build, which shows the cloud backup: popup 59,119 (59,114), side panel 61,371 (61,368).
- On the tree of both patches of round 2, 2026-10-31, under `nice -n 19` in the shared lock: the gates of §7.8 (format,
  `scripts/messages.py` unchanged by a second run, typecheck, the three flavours built and checked, format:check,
  notices:check); targeted, 59 files, 1,318 tests, all passed; the e2e specs in the port-switched copy (18937, no 8787):
  `cloud-pages.spec.ts` (6), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 11 passed. **The full unit suite**,
  `npx vitest run --maxWorkers=2`: 315 files, 5,090 passed, 4 expected failures and 1 skipped (the suite's own
  markers); 1,196 s.

### 8.6 Round 3 (REVIEW-P5P6-r2.md)

- The recheck found nothing in patch 6; it is rebased on patch 5's third round with no change of its own code.
- Sizes (store build): popup 58,377, side panel 60,600, as in round 2; `sw.js` 102,634 (§7.9). In the e2e build: popup
  59,119, side panel 61,371, as in round 2.
- On the tree of both patches of round 3, 2026-10-31, under `nice -n 19` in the shared lock: the gates of §7.9;
  targeted, 59 files, 1,333 tests, all passed; the e2e specs in the port-switched copy (18937, no 8787):
  `cloud-pages.spec.ts` (6), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 11 passed. **The full unit suite**,
  `npx vitest run --maxWorkers=2`: 315 files, 5,105 passed, 4 expected failures and 1 skipped (the suite's own
  markers); 1,199 s. The catalogs `scripts/messages.py` writes, made twice from nothing under two hash seeds, are byte
  for byte the same, and the same as this tree's.

### 8.7 Round 4 (REVIEW-P5P6-r3.md)

- The recheck found nothing in patch 6; it is rebased on patch 5's fourth round with no change of its own code. One test
  it carries changed with patch 5's C3: `cloudbk-auth-rules` lets a click leave first when one is under way, before
  `askIdentity()`, with nothing awaited before the ask (§7.10).
- On the tree of all three, d2e3411 + P5-r4 + P6-r4 + NFKC-RK (the full-width recovery key, a patch of its own, §7.10
  C1), 2026-10-31, under `nice -n 19` in the shared lock: the gates of §7.10; sizes (store build): popup 58,385, side
  panel 60,617, settings page static load 125,126, `sw.js` 102,764 (NFKC-RK's `normalize` is the few bytes over P5-r4's);
  in the e2e build popup 59,116, side panel 61,371, `sw.js` 101,730. Targeted, 79 files, 1,732 passed and 1 skipped
  (the code-reading tests of NFKC-RK's entry points among them); the e2e specs in the port-switched copy (18937, no
  8787): `cloud-pages.spec.ts` (6), `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 11 passed. **The full unit suite**,
  `npx vitest run --maxWorkers=2`: 316 files, 5,119 passed, 4 expected failures and 1 skipped (the suite's own
  markers); 1,220 s. (The first full run found the identity rule's test of §7.10; it was fixed, and this is the
  second.)

### 8.8 Round 5 (REVIEW-P5P6-r4.md)

- The recheck found nothing in patch 6; it is rebased on patch 5's fifth round with no change of its own.
- On the tree of all three, d2e3411 + P5-r5 + P6-r5 + NFKC-RK-r2 (the full-width recovery key and, now, TOTP secret:
  a patch of its own), 2026-10-31, under `nice -n 19` in the shared lock: format, `scripts/messages.py` (unchanged by a
  second run), typecheck, the three flavours built and checked (`OK`), format:check, notices:check. Sizes (store
  build): popup 58,383, side panel 60,614, settings page static load 125,121, `sw.js` 102,761; in the e2e build popup
  59,115, side panel 61,365, `sw.js` 101,725. Targeted, 91 files, 1,997 passed and 1 skipped (the code and key
  reading tests among them); the e2e specs in the port-switched copy (18937, no 8787): `cloud-pages.spec.ts` (6),
  `cloud-worker.spec.ts` (3), `smoke.spec.ts` (2): 11 passed. **The full unit suite**, `npx vitest run
  --maxWorkers=2`: 316 files, 5,126 passed, 4 expected failures and 1 skipped (the suite's own markers); 1,255 s.

## 9. After the merge: the review of round 5 (REVIEW-r5.md)

Patches 5 and 6 were merged as 77d046c, and NFKC-RK's second round as cafc585. The review asked for nothing; its two
suggestions are this follow-up, CLOUD-FU:

- **E1.** The reviewer's real-chain probe is a test, `test/unit/cloudbk-disconnect-chain.test.ts`: "断开" through
  createCloudWorker, its Google sessions, GoogleAuth and the transport, with only fetch and chrome.* stubbed (about
  100 ms). It holds the seam the worker's tests cannot see past their stub session. One case more than the probe: the
  browser's account changed and "断开"'s own run is the first to find it, so the reviewer's V7 (R4-1 undone) dies here
  too, beside V6b (GoogleAuth revoking another account's token).
- **E2.** `otpauth.ts` asked whether the secret is empty before NFKC: a secret of full-width "＝＝" alone was
  `invalid_secret` where "==" is `missing_secret`. It now asks what is left once read as base32 reads it
  (`cleanBase32`), so the two agree; a test in `nfkc-codes.test.ts`.

Mutants (`r2tools/mutants-fu.py`): V6b, V7, and a silent token counted whoever's it is, against the chain test; E2's
check undone three ways (before NFKC again, gone, on NFKC alone). All 6 are killed by an assertion.
