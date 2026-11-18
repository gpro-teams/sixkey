# CSB notes: the encrypted backup in Chrome's sync storage, CSB-0 to CSB-5

CSB is Sixkey's automatic backup into `chrome.storage.sync`: the service worker writes the vault as it is on disk,
encrypted and with no key needed, into the browser's own sync storage, and Chrome's sync carries it to the other
computers signed in to the same Google account. On a new computer, "从 Chrome 同步恢复" / "Restore from Chrome Sync" and the
master password (or the recovery key) bring it back. It replaces the Google Drive backup through a separate plugin,
withdrawn on 2026-11-06 ([CLOUDBK-NOTES.md](CLOUDBK-NOTES.md), [CLOUD-PLUGIN-NOTES.md](CLOUD-PLUGIN-NOTES.md)): that
plugin was never published, and its path, unwired in every build since CSB-3, is removed (16). Since CSB-5 (`648772b`,
2026-11-08) every build has the whole of it: the worker, Settings › Backup's card, first run's box, the restore, the
merges, the popup's and the side panel's pill and the welcome's offer. The encrypted backup file (Settings › Backup)
stays, beside it.

These notes record what was built, patch by patch (1), the layout in Chrome sync and its numbers (2, 3), the write rule
(4), when the worker runs and what the status records (5), the records (6) and the messages (7), who may write the area
(8), the pages (9), what the status may claim and why (10), capacity (11), the known limitations (12), what is not
verified (13), the sizes (14), the tests and mutants (15), and the removal of the Google Drive path (16). The names in
them are held to the code by `test/unit/csb-notes.test.ts`: every message the worker answers, both records and their
fields, the manifest's fields, the alarms and the numbers of section 3; and no `sk-csb-` or `sk_` name here that the
code does not have.

Paths are under `extension/` unless they start with `docs/`. The owner's standing rules this work is held to: backup is
one click, automatic, with its status in view; warn, do not block; every claim on a page true of what the code can know.

## 1. The patches

| Patch | Commit | What it did |
|---|---|---|
| CSB-0 | `ff99963` | The store build stops pointing to the cloud-backup plugin: `scripts/google-oauth.mjs` `cloudUiIn` is false there, so no card, no restore from Drive, no offer at the end of first run, no popup pill or one click; the build drops the settings page's three cloud page chunks and stops if a page could still load one; the store catalog leaves the plugin's entry out. A downloaded cloud backup file still restores through first run. README, ROADMAP, PRIVACY and CLOUDBK-NOTES said so |
| CSB-1 | `f9226cc` | The pure core, imported by no entry point: `src/core/cloud/slots.ts` (keys, the strict manifest, the exact measure, `planSlot`, `assembleSlot`, `readSlots`, `room`, the write rule `decideSlot` and the link's moves) and the status's new errors and stopping set (`src/core/cloud/status.ts` `csbStatus`). The store and e2e builds were byte for byte as before |
| CSB-2 | `0532f24` | The one module that writes the area, `src/platform/csb-area.ts`; the pages' reader (then `options/csb/read.ts`, now `src/platform/csb-read.ts`); `src/platform/storage-access.ts` `restrictSyncAccess`; the unit tests' fake area `test/helpers/fake-sync-area.ts`; and the browser probe `test/e2e/csb-probe.spec.ts`, which pinned what Chromium does with the area (section 2). The probe corrected the measure of a manifest's time. Still unwired: the store and e2e builds were byte for byte as before |
| CSB-3 | `1d1158a` | The worker: `src/platform/csb-worker.ts` (the scheduling moved here from the Drive path's `cloud-worker.ts`), `src/platform/csb-config.ts` (the records), the store's recovery hook marking the link held (`src/platform/cloud-mark.ts`), the settings page's `sk-csb-*` rows in `sender-policy.ts`, and storage.sync's access level set at every worker start, before any listener. The Drive path is unwired in every build: no Drive worker, no plugin listener, no `sk-cloud-*` handler, `cloudUiIn` false in every flavour; its five browser specs retired. Off until a page turns it on, and no page could yet |
| CSB-4 | `95129f9` | The settings page: Settings › Backup's card, first run's box and the copy found there, the restore from Chrome Sync, the merges (`src/options/csb/`, one lazy chunk through `CsbPages.ts`, with the `csb` catalog and `scripts/i18n/csb.py`), in every build. `sk-csb-restored`, `sk-csb-merged` and `sk-csb-drop` name the generation the page wrote, sent from inside the store's lock that committed it. PRIVACY.md, ARCHITECTURE.md and `docs/security/local-vault.md` describe the backup |
| CSB-5 | `648772b` | The popup and the side panel: the pill and the footer (`src/popup/main/CsbPop.tsx`, in place of the Drive path's `CloudPop.tsx`, with the `csb-popup` catalog and `scripts/i18n/csbpopup.py`), the footer's one click handed to the card, the records read in the open's own read of the settings; the welcome's offer of a copy found (`src/popup/screens/CsbFound.tsx`, opening `#setup-csb`). The reader moved to `src/platform/csb-read.ts`, the slots' limits to `src/core/cloud/slot-limits.ts`, the time helper to `src/ui/ago.ts`, the browser's word to `src/ui/csb-brand.ts`, so the popup loads none of the settings page's code |

Each patch was reviewed independently and changed after its review (a second round); the commit messages list what each
round changed. CSB-1's review found no device writing or removing a slot it does not own, no empty device overwriting a
backup, and no live device's account lost outside the race of section 12. CSB-4's review found one thing that had to
change before the merge: a merge's removal could leave Chrome sync with neither copy (two vaults of 150 accounts each);
the worker now removes none unless this computer's copy then fits. CSB-5's found one: the reminder to back up shown
beside a backup that runs; no reminder shows while it runs now.

## 2. The layout in Chrome sync

```text
bk1.<slot>       { v, g, n, z, h, t }
bk1.<slot>.<i>   a piece of the file's text, i = 0 to 12
```

- **A slot** is one device's copy, named by a random 8-character id of `[a-z0-9]` (`newSlotId`, unbiased). A device
  writes only the slot it made, or the one it adopted at a restore (section 4).
- **The manifest** `bk1.<slot>`, read strictly (exactly these fields, anything else is not a slot this version uses; a
  later version's `v` reads as "newer" and is left alone): `v` 1; `g` a random 64-bit tag, hex, new at every write; `n`
  the chunk count; `z` the text's length; `h` its SHA-256 in canonical base64; `t` the generation's `savedAt`, which the
  file inside must agree with. No device name, no account count, no vault id.
- **The chunks** `bk1.<slot>.<i>` are plain strings: pieces of the cloud backup's file text (`src/core/cloud/format.ts`
  `cloudBackupText(makeCloudBackup(...))`, unchanged from the Drive path), so a reassembled text parses as a file does.
  The text is printable ASCII without `<`, `>`, `&` and the backslash (`planSlot` refuses anything else), so what each
  item takes is known exactly: its key, two quotes, the text, one more byte per quote. Each chunk is as long as its item
  allows, so a text is cut the same way every time.
- **One write is one `set`** of the manifest and chunks 0 to n-1, and one `remove` only when the slot shrank (the chunks
  past the new count). Keys of any other shape are never read, but count as used space; `bk2.` is left free for a later
  format.
- **A reader uses a slot only when it is whole**: the manifest parses, chunks 0 to n-1 are all there, the joined text
  has the length `z` and the hash `h`, the file parses with the store's own checks (shape, envelope checksum) and its
  `savedAt` is `t`. Anything else is `partial` (still arriving: Chrome sync carries each item on its own, in any order),
  `invalid` or `newer`, and never used. A mix of two writes fails the hash; past it, the envelope checksum and AES-GCM
  would refuse it.

**What the browser probe measured** (`test/e2e/csb-probe.spec.ts`, Playwright's Chromium 156 with the e2e build, a fresh
profile signed in to no Google account; the refusal texts also in Chromium 145):

- `storage.sync` works signed out, kept on the computer; a page's `onChanged` gets one event for a `set` of many items.
- An item takes its key and its value's JSON as Chromium writes it: 8,192 bytes taken, 8,193 refused, with and without
  quotes, for keys of 12, 14 and 15 characters. A double whose decimal exponent is 12 or more (every real `savedAt`) is
  written in exponent form (`1.79337934196e+12`, 17 bytes, where `JSON.stringify` writes 13); `slots.ts` counts it so
  since the probe (it had been up to 3 bytes short; the margins covered that).
- The area takes 102,400 bytes and refuses one more; 512 items are taken and the 513th refused. A refused `set` writes
  none of its items.
- A whole plan's `getBytesInUse(null)` is the plan's bytes, and after a shrink what `room` assumes, before and after the
  remove of the leftovers. `getBytesInUse` counts a key asked twice twice.
- `set` and `remove` each have 120 calls a minute (the 121st refused, a `clear` still passing); a `set` refused for its
  bytes counts; reads count nothing.
- Chromium's refusal texts are not the documented names: `Resource::kQuotaBytes quota exceeded`,
  `Resource::kQuotaBytesPerItem quota exceeded`, `Resource::kMaxItems quota exceeded` (no period), and `This request
  exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.`. The hour's text is not measured (1,800 calls); it is taken as the
  minute's template. Any other text is "other", so a text a later Chrome changes costs a retry, never a wrong stop.
- `setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` on `storage.sync` is accepted; a content script's `get`,
  `getBytesInUse`, `set` and `remove` are then refused and its `onChanged` listeners hear nothing, while the worker
  still reads and writes and the pages still read; the level outlives a restart of the worker.

The fake area of the unit tests (`test/helpers/fake-sync-area.ts`) counts as Chromium does for every value the probe
tried, with its quotas, texts, write counters, `onChanged`, and a "remote" that delivers another computer's items one by
one in any order.

## 3. The numbers

| Name | Value | What |
|---|---|---|
| `QUOTA_BYTES` | 102,400 B | Chrome's room for all of an extension's sync items (keys and values, as Chrome counts them) |
| `QUOTA_BYTES_PER_ITEM` | 8,192 B | Chrome's limit for one item |
| `ITEM_MARGIN` | 16 B | kept free in every item a slot writes |
| `ITEM_BYTES` | 8,176 B | the most an item of a slot takes |
| `AREA_MARGIN` | 256 B | kept free of the whole area |
| `ROOM_BYTES` | 102,144 B | the most one slot, or all of them together, may take |
| `MAX_CHUNKS` | 13 | the most chunks a slot has (thirteen full chunks are past the room) |
| `EMPTY_BELOW` | 256 | a vault's ciphertext shorter than this is an empty vault's (no longer used by the write rule since 2026-11-17) |
| `MAX_MINE` | 16 | how many of the slot ids it created a link remembers |
| `SOON_MS` | 30 s | the debounce: a write this long after the last change (5 s in the e2e build) |
| `MAX_WAIT_MS` | 5 min | the debounce's ceiling after the first of changes that keep coming |
| `RETRY_MS` | 1, 5, 30 min | the retries after the first, second and third failure in a row |
| `DAILY_MS` | 24 h | the daily check: a run when none happened for this long |
| `STALE_AFTER_MS` | 3 days | changes waiting this long make the status "stale" |
| `USAGE_FROM` | 60 % | the card's usage line from this share of the area |
| `NEAR_FULL_FROM` | 85 % | the card's "nearly full" line from this share |

The two margins stay although the probe found the measure exact in Chromium 156: they are for the browsers not measured
and for a later change of how Chromium writes a value, and they cost no account at the sizes measured (section 11).

## 4. The write rule, in order

The worker cannot decrypt, so the rule is about lineage (`slots.ts` `decideSlot`). Its inputs: the generation on disk as
the store reads it with no key (its save counter, envelope checksum, vault id, key id, `opens`, the wraps), the link
(`sk_csb_cfg.link`), and this device's own slot as read now.

| # | When | Then |
|---|---|---|
| 1 | (none since 2026-11-17) | an empty vault is written like any other, so a second computer finds it as soon as the master password is set; it used to be skipped, and a second computer then offered a new master password instead of the restore |
| 2 | no link (never written, or the record did not check out) | a new slot |
| 3 | the link is held (the store fell back to an older copy, or rule 7 held it) | hold, until a page merges the slot |
| 4 | its own slot is absent (Chrome's "Clear data", an uninstall elsewhere, a merge's removal) | write it again under the same id |
| 5 | its own slot carries a tag this device did not write or adopt (another computer adopted it at a restore, a cloned profile, a later version's format) | a new slot; theirs is left as it is |
| 6 | another vault than the link's (started over; a file restored over unreadable data) | a new slot; the old one is left whole |
| 7 | a save counter below the link's, or the link's counter with another envelope (an older copy put back by hand) | hold, as rule 3 |
| 8 | nothing changed (counter, key, `opens`, wraps), the slot whole and carrying the last write's tag, and no merge owed | skip (and remove the leftover chunks a stopped worker left beside it) |
| 9 | otherwise | overwrite its own slot |

Then the room: no item past `ITEM_BYTES`, no slot past `ROOM_BYTES` (`too_large`), and none past what the other items
leave (`no_room`; the items a write overwrites free their bytes). Nothing is trimmed to fit: the old slot stays as the
last copy that fitted. A unit test runs all 21,504 combinations of the rule's inputs against the rules written as a
table.

**The order of one write**, in the worker, under the records' lock (`webLock("sixkey-csb")`):

1. Read the area once (`readArea`); decide; plan the write under a new tag; check the room.
2. Save the link as it will be after the write, its new tag `pending` (`linkBefore`), so that a worker stopped after the
   `set` takes the slot as its own at the next run instead of forking.
3. One `writeSlot`: one `set` of the manifest and chunks 0 to n-1, the plan checked again first (shape, lengths, hash,
   bytes; a malformed plan is a bug and makes no call).
4. If the slot shrank, one `removeLeftovers` of its chunks past the new count.
5. Save the final link (`linkAfter`: the tag, what was written, `pending`, `held` and `dirty` gone) and
   `sk_last_backup`.

A hold is saved as `held` (`heldLink`), so later saves cannot raise the counter past the link's and let a run overwrite
the newer slot. Chrome's `QUOTA_BYTES` refusal leads to a second read of the area: `no_room` only if the plan still does
not fit there, else "other" (another computer's shrink in flight).

## 5. When the worker runs, and what the status records

- **When.** `SOON_MS` after the last change of the vault (the store's pointer `sk_active`, written by every commit in
  any context; one alarm, `sk-csb-soon`, re-armed), at most `MAX_WAIT_MS` after the first of changes that keep coming.
  One run at a time, and one more after it when a change came meanwhile. After a failure, retries at 1, 5 and 30 minutes
  (`sk-csb-retry`), then the worker's six-hourly routine, which at every start and every six hours runs when changes
  wait with no alarm left, or when no run happened for `DAILY_MS` (the daily check, which also writes again a slot
  Chrome's "Clear data" removed and finds room another computer freed). Nothing runs while the backup is off.
- **Only where the area is closed.** Every worker start sets `storage.sync`'s access level to `TRUSTED_CONTEXTS` among
  its first three calls, before any listener (`src/background/storage-access-first.ts`; check-dist runs the built
  worker's top level to hold the order). Where the browser refuses, nothing runs in that worker's life, `sk-csb-on` and
  an adoption are refused (`unsafe_area`), a diagnostics line is written, and the state records `unsafe` for the card.
  Autofill's gate stays on `local` and `session` alone, so no browser loses autofill over this.
- **What a run reads.** The generation as the store has it with no key (`VaultStore.load`, before the records' lock,
  outside every lock): locked or not, in "lock every time" mode, after a restart, the same. It decides only on the
  generation still on disk under the lock; one a commit replaced meanwhile is left to that commit's own run, and none is
  decided on when none on disk can be read.
- **The status's errors.** Stopping (no retry; the card says what to do, the daily check tries again): `too_large` (the
  vault alone does not fit), `no_room` (it fits alone, not beside the other copies), `held` (rules 3 and 7),
  `no_password` (a vault kept under a device key, or no wrap that opens the file), `unreadable` (the data on this
  computer cannot be read). Retried: `busy` (a write-operation quota) and `other` (anything else Chrome says, with its
  text in a diagnostics line). A malformed plan or key list is a bug: a diagnostics line, no retry alarm. Changes
  waiting `STALE_AFTER_MS` or more are "stale".

## 6. The records

Both in `storage.local`, read strictly (`src/platform/csb-config.ts`): a record that does not check out is a backup
never set up (off), a link that does not is no link (the next write makes a new slot, which overwrites nothing), a state
that does not is a fresh one. Neither holds a secret: slot ids, tags, the save counter, the envelope checksum, ids and
the wraps' IVs (all in the copy itself), times and byte counts.

```text
sk_csb_cfg       { v, on, opens, declined, link }
  link           { v, slot, gen, pending?, seq, sum, vaultId, vkId, opens, wraps, held?, dirty?, mine }
sk_csb_state     { v, lastOk, err, errSince, pendingSince, retries, lastRun, bytes, used, others, seen, unsafe? }
  others         { n, bytes, otherVaults, latest }
```

- `sk_csb_cfg`: `on`; `opens` ("both", or "recovery" for the card's switch "只用恢复密钥打开"); `declined` (the person turned it
  off: the popup's reminder no longer turns it on through the card); `link`, this device's slot or `null`. The link:
  `slot`; `gen`, the tag it last wrote or found when it adopted the slot; `pending`, an overwrite's tag saved before its
  `set`; `seq`, `sum`, `vaultId`, `vkId`, `opens`, `wraps`, what was written (the wraps as their methods and IVs);
  `held` (rules 3 and 7); `dirty` (a restore merged more than one slot, or a page merged the held one: the next run
  writes though nothing changed); `mine`, the last `MAX_MINE` slot ids this device created.
- `sk_csb_state`: `lastOk`, `err`, `errSince`, `pendingSince`, `retries`, `lastRun` for the status line and the
  scheduling; `bytes` (this slot), `used` (the whole area, as Chrome counts it), `others` (the other slots: how many,
  their bytes, how many whole ones are another vault's, the newest whole one's time), `seen` (a slot this device did not
  create was seen, or it was restored from one: sync carries the area), `unsafe` (this worker could not close the area;
  a record written before the field reads false).
- **Who writes them.** The worker alone, but for the store's recovery hook (`src/platform/cloud-mark.ts`), which every
  context builds the store with: inside the store's lock, before each recovery write, it takes the records' lock and
  marks the link held, and nothing else. The popup reads both with the settings, in the open's own read.
- **Beside them.** `sk_last_backup` is set by every write, so the popup's 7-day "立即备份" reminder does not ask while the
  backup works; `sk_cloud_go` (`chrome.storage.session`, `src/platform/cloud-go.ts`) is the time of the popup's "立即备份"
  click, which the card takes within a minute.

## 7. The messages

From the settings page alone (`src/platform/sender-policy.ts`: the receiver is the worker, the only sender `options`),
answered after the work by their own listener in `src/background/sw.ts`, each handled by `src/platform/csb-worker.ts`.
The popup and the side panel never send one: check-dist holds every chunk they can load to that.

| Message | Fields | What the worker does | Refused with |
|---|---|---|---|
| `sk-csb-on` | none | on (no unlock needed), the error cleared, a run now | `unsafe_area` |
| `sk-csb-off` | none | off and `declined`; this device's own slot removed (under its `gen` or `pending` tag), but while held, not when another computer took it over, and not when the link is another vault's than the one on disk (that may be the old vault's only copy) | never; answers whether it removed |
| `sk-csb-now` | none | a run now, answered when it and any run a change asked for meanwhile are done | `off`, `unsafe_area` |
| `sk-csb-opens` | `opens` | the switch kept, written at once while on | an `opens` other than "both" or "recovery" |
| `sk-csb-restored` | `slot`, `gen`, `opens`, `wraps`, `dirty`, `seq`, `sum` | a restore's adoption: this device continues that slot from the tag it read, on; taken only while the vault on disk is the generation the restore wrote, the slot still whole under that tag and holding this vault | `bad_message`, `unsafe_area`, `not_that_generation`, `slot_changed`, `other_vault`, `unreadable` |
| `sk-csb-merged` | `slot`, `gen` (or `null`), `seq`, `sum` | the held slot merged: the link re-based on the merge and marked `dirty`, the hold lifted, a run now; taken only while the vault on disk is the merge's generation and the slot still carries the tag the page read, whole | `bad_message`, `not_held`, `not_that_generation`, `unreadable`, `slot_changed` |
| `sk-csb-drop` | `slots` (each `slot` and `gen`), `seq`, `sum` | a merge's removal of other slots: none unless the vault on disk is the merge's generation and this computer's copy then fits; then each slot still whole under the tag read, never this device's own | `bad_message`, `not_that_generation`, `would_not_fit` |

`sk-csb-restored`, `sk-csb-merged` and `sk-csb-drop` lift or replace a hold, or remove copies, so they are named by the
generation the page wrote (its save counter and envelope checksum), sent from inside the store's lock that committed it,
and handled under the store's lock (`webLock("sixkey-vault")`) and then the records' lock, the recovery hook's own
order: no recovery can come between its mark and its write while they compare. Answered `not_that_generation`, the page
merges the same data again over the vault as it is and names that generation, once; answered `slot_changed`, it reads
the copy again, opens and merges it, once. Then a merge says "try again", and a restore goes on as a new copy of its
own, which overwrites nothing. Never a loop.

The worker's two alarms, `sk-csb-soon` and `sk-csb-retry`, share the prefix; they are not messages.

## 8. Who may write chrome.storage.sync

Held by source rules (`test/unit/source-rules.test.ts`) and by check-dist:

- `storage.sync` is named only in `src/platform/csb-area.ts` (the writer), `src/platform/csb-read.ts` (the pages'
  reader) and `src/platform/storage-access.ts` (its access level). `chrome.storage` and its sync area are never kept,
  destructured or handed on, but as those modules' default areas, whose handles are not exported.
- `csb-area.ts` has one `set` and one `remove` and never clears or sets the level; `csb-read.ts` never writes and has
  one `get(null)`. Only `csb-worker.ts` imports `csb-area.ts`, by name, and no page imports the worker.
- In the worker, the run (`decideAndWrite`) makes the one `writeSlot` and the only `removeLeftovers` calls, and never
  removes a slot; `removeSlot` is called by "turn off" (`turnOff`) and by a merge's removal (`dropSlots`) alone. A run
  loads the vault once, before the records' lock, and works out the card's numbers once, after it.
- The worker and the store's hook use one lock under one name, and the worker's store lock is the store's own.
- `sk-csb-*` messages come from the settings page only; nothing the popup or the side panel can load names one.
- Nothing local is ever changed because Chrome sync is empty, smaller or older: data enters the vault only at a restore
  or a merge the person clicks.

## 9. The pages

- **Settings › Backup's card** (`src/options/csb/CsbCard.tsx`, its states `src/options/csb/model.ts` `cardView`): off
  (the one button "开启", the body, the cost line, the switch "只用恢复密钥打开"; in a shared profile, whose Google account it
  would go to), unsafe, empty (no account yet), saving, ok ("已交给 Chrome 同步 · 3 分钟前"), waiting, failed (a passing error,
  retried), stale, stopped. A problem is amber and blocks nothing; what fixes it sits beside "关闭": the encrypted file
  ("保存加密备份") when the vault is too large or the space is full, a merge where this computer's data may be older than its
  copy in Chrome Sync (held) or other copies take the room. "关闭" removes this computer's copy, but while held, and says
  so. From 60 % of the area a usage line, from 85 % how many more accounts fit. Within a screen and a half with the rest
  of Settings › Backup at 1400 × 900, in every state (`test/e2e/csb-card-visual.spec.ts`).
- **First run's box** (`src/options/csb/CsbFirstRun.tsx` `CsbBox`): "自动备份到 Chrome 同步（推荐）" at the last step of every
  first run (a new vault, starting over, a restore from a file or from Chrome Sync), ticked when the profile is "only
  me", cleared for a shared one, with the cost line beside it. Ticked, the backup is turned on after "完成" and the
  vault is handed over at once, empty or not; cleared, it is recorded as turned off (`declined`), so the popup's one click does not turn it
  on later; a shared profile's box, never ticked, records nothing. A vault that already exists is never turned on by
  itself.
- **The copy found, and the restore.** On a new install, first run reads Chrome Sync keyless and read only, and a whole
  copy is offered above the master password ("在 Chrome 同步里找到了 Sixkey 的备份（最近一份 …）", "从 Chrome 同步恢复" first, "新建" kept),
  also one that arrives while the page is open. The restore step (`#setup-csb`) has no sign-in: the copies are watched
  while it is open, a copy still arriving is never used ("备份还没同步完整，Chrome 同步完会自动继续"), then one field takes the master
  password or the recovery key; every copy it opens is merged (`src/core/cloud/restore.ts` `openCloudBackups`, unchanged
  from the Drive path), and this computer adopts the newest (`sk-csb-restored`). What is typed never leaves the page;
  the worker never sees it. With no readable vault, Settings › Backup offers the same restore.
- **The merges** (`src/options/csb/merge.ts`, with the vault open): a held copy, opened with a key held here or, after a
  key change, with what is typed ("合并并继续"); another vault's copies, merged as added accounts, then removable at a click
  ("从 Chrome 同步删除它们"); when the space is full, every other copy that opens merged and then removed ("合并到这台电脑并删除它们"). A
  copy is removed only if it opened, was merged, and its tag did not change since it was read.
- **The popup's and the side panel's pill and footer** (`src/popup/main/CsbPop.tsx`, a lazy chunk): the popup's own "本机"
  while the backup is off; "Chrome 同步" with a check once it is on, its title "已交给 Chrome 同步 · 3 分钟前"; amber "备份已停" when
  the card's line is a problem only the person can fix (stopped, stale, unsafe), with the footer "N 个账户 · 备份出了问题"
  opening Settings › Backup. A passing failure stays on the card. While the backup runs, the footer shows the account
  count only. With the backup off, never turned off, a week without a backup and a profile only the person uses, the
  footer's "立即备份" leaves "turn on now" (`sk_cloud_go`) and opens the card, which turns the backup on as it loads, its
  cost line in view. The records come with the open's own read of the settings: the popup's read counts are as before (6
  for an open, 10 for an unlock).
- **The welcome** (`src/popup/screens/CsbFound.tsx`): with no vault here, it reads Chrome Sync keyless and read only,
  and again when a copy arrives; a whole copy is said with when, and its "从 Chrome 同步恢复" is the first button and opens
  first run's restore (`#setup-csb`). A copy still arriving is not offered.
- **Another browser than Google Chrome** (`navigator.userAgentData` names no "Google Chrome": Edge, Brave, Chromium):
  "Chrome 同步" reads "浏览器同步", no line names a Google account, and the card says Sixkey cannot tell whether that browser's
  sync carries an extension's data, so an encrypted backup file is worth saving too (`src/ui/csb-brand.ts`).

## 10. What the status may claim, and why

`storage.sync` silently stays on the computer when Chrome is not signed in, when sync is off or paused, when
"Extensions" is left out of what it syncs, and in a browser whose sync does not carry extension data. The API gives no
receipt, and Sixkey cannot read Chrome's sync state (that would need `identity.email`, an install warning, and would
still not show the per-type setting). So:

- **The act, never the outcome.** "已交给 Chrome 同步 · 3 分钟前" / "Handed to Chrome Sync · 3 minutes ago", never "backed up"
  or "in the cloud" (the unit tests read every line of both catalogs for that). Beside every state that says or offers
  it, the honest line: Chrome uploads only while signed in with sync on, extensions included; Sixkey can confirm it
  handed the backup to Chrome, not that Chrome uploaded it.
- **Evidence when there is some.** A slot this device did not create can only have come through sync; once one is seen,
  or this computer was restored from one, the card says another computer's backup arrived, so Chrome Sync carries copies
  here.
- **The cost line, always:** it opens with the master password or the recovery key, and anyone who gets into the Google
  account could try to guess the master password; with "只用恢复密钥打开", there is no password to guess.
- **The reminder.** `sk_last_backup` is set at every write and no reminder shows while the backup runs: a vault
  unchanged for a week is not handed over again, and its copy is the vault as it is. The honest line is the
  counterweight.
- **The popup speaks up only for what only the person can fix**; passing failures are retried by the worker and shown on
  the card alone.

## 11. Capacity

Pinned by `test/unit/csb-slots.test.ts` with the real code (`makeCloudBackup` over vaults of typical accounts: a
32-character secret, an e-mail label, one site; the master password's wrap at the shipped iteration count; the margins
of section 3):

| Typical accounts | Bytes in Chrome sync |
|---|---|
| 30 | 15,180 |
| 100 | 48,148 |
| 200 | 92,699 |

About 454 bytes an account. As many typical accounts as fit: **about 220 with one computer writing, 106 each with two
computers, 70 each with three**, since every computer writes its own copy into the same 100 KB. Accounts in the trash
keep their full entry and erased ones a tombstone, and both count. Past the room, that computer's backup stops
(`too_large` or `no_room`, amber, nothing blocked) and the card points to the encrypted backup file; "合并到这台电脑并删除它们"
frees the room other copies take, once they are merged here.

## 12. Known limitations

- **Two writers on one slot.** After a restore, two computers can hold one slot (the restored one adopted it while the
  first still runs, or a profile was cloned). Each writes what it holds; whichever write lands last is the slot, and the
  other forks at its next run (rule 5) and writes what it holds to a new slot. What neither holds any more is gone: if
  the first computer starts over (or restores a file over its vault) before its next run, an account only its
  overwritten write had is in no vault and no slot. `slots.ts` says so where the rule is; the unit model lets go exactly
  those accounts.
- **A copy put back by hand, before the worker runs.** Rule 7 compares the save counter only: if two or more saves are
  made on an older copy of the profile put back by hand before the worker runs (30 s after the last change), the counter
  has passed the link's, the copy looks like a descendant, and the next write overwrites the slot with the older data.
  The store's own fallbacks are not this case: its recovery hook marks the link held (rule 3). A unit test pins the
  window.
- **A computer lost while Chrome uploads.** A slot is overwritten in place. A computer lost after its `set` and before
  Chrome uploaded every item of it leaves the slot incomplete on Google's side for good: no reader uses a partial slot,
  so that computer's whole copy is gone, not only its last change. The same holds for the old vault's slot of a computer
  that started over: nothing writes it again, so a computer lost before Chrome finished uploading it leaves it
  incomplete. A restore says the copy has not fully arrived and waits, up to its time limit.
- **Chrome's "Clear data"** in Google's sync settings removes every copy. Computers still in use write theirs again at
  their next run or daily check (rule 4); a lost computer's copy is gone for good.
- **Uninstalling Sixkey on one computer may remove the copies everywhere** (not verified). As above, the computers in
  use write theirs again.
- **Other browsers.** Whether Edge, Brave or another browser carries `storage.sync` between its installs is unknown; the
  wording says so there ("浏览器同步", and the card's line that Sixkey cannot tell).
- **What Google can see**: that the Sixkey extension keeps data in Chrome sync, each copy's size (about the number of
  entries), its times, random ids and tags, save counters, key-derivation settings and Sixkey's version; not the
  accounts (PRIVACY.md).

## 13. Not verified

- Whether Chrome signed in to a Google account **without** sync turned on carries `storage.sync` to another computer.
- Whether uninstalling Sixkey on one computer removes its sync data on every computer.

The browser tests run an unpacked build in a profile signed in to nothing, where the area stays on the computer; they
cannot answer either. Both are for the owner's check on two real computers signed in to the same Google account, item 59
of `docs/OWNER-CHECKLIST.md`: the same developer build on both (its extension ID is fixed, and Chrome sync carries an
extension's data by its ID); on the first, a new vault with the box ticked and an account added; on the second, "从
Chrome 同步恢复" offered, the master password restoring that account, and the card saying that this computer received
another computer's backup (the first computer never says it here: the second continues the first's own copy, and every
copy the first sees is one it created); then "Extensions" left out of the first's sync, another account added, and
nothing arriving on the second while Sixkey still claims only the handing over; optionally, Chrome signed in without
sync, and an uninstall on one computer. Until it is run, both stay unverified: the card claims only the handing over,
and PRIVACY.md says the uninstall's effect is not verified. Whether Chrome carries an unpacked extension's sync data at
all is not verified either; the check says so.

## 14. Sizes

Gzip bytes, from check-dist at each merge. The popup and side panel figures are the store build's counted static code
with both UI gates that are still closed in the store build opened (sync and code suggestions), against their caps.

| After | Popup (cap 59,640) | Side panel (cap 61,688) | Store build's worker (budget 106,496) |
|---|---|---|---|
| CSB-0, CSB-1, CSB-2 | 59,357 | 61,593 | 101,509 |
| CSB-3 | 59,398 | 61,637 | 100,029 |
| CSB-4 | 58,742 | 60,970 | 100,468 |
| CSB-5 | 59,148 | 61,383 | 100,532 |
| CSB-R | 59,149 | 61,384 | 100,478 |

- CSB-3's worker lost the Drive path (its worker, provider, rules and remote calls) and gained the slots, the writer and
  the backup's worker: 1,480 B smaller. Its 41 and 44 B more in the popup and the side panel came from `cloud-mark.ts`
  moving into the `runtime-base` chunk, and `activeKeyring` reading through `activeGeneration`.
- CSB-4: the settings page no longer imports the Drive path, and a chunk the pages shared merged into another: the popup
  and the side panel lost about 660 B. The worker grew by 439 B (the `unsafe` mark, the removal's generation and fit
  checks).
- CSB-5: the pill's chunk and the records in the open's read (+406 B popup, +413 B side panel); the worker's settings
  read with the two keys (+64 B).
- CSB-R: the worker lost the Drive path's twelve message rows and their check, and `backups.transport` from what is
  offered, and gained the retired capability's reading of a stored approval (54 B smaller all told). The popup and the
  side panel load the same code, each file of the same length; only the names of the chunks they may load changed (the
  plugin chunks, which changed, under new hashes, and every chunk that names them), which gzip 1 B larger each.
- The store build as it ships (gates closed): popup 58,178 B, side panel 60,410 B, worker 100,532 B at CSB-5; 58,176,
  60,405 and 100,478 B at CSB-R.
- The catalogs, each with its own budget in check-dist: `csb` (the settings page's text) 2,417 B (en) and 2,693 B
  (zh_CN) of 4,096; a vault's page with it 12,196 and 13,552 B, first run with it 5,991 and 6,698 B, of 15,360;
  `csb-popup` (the popup's text) 245 and 312 B of 2,048.
- The manifest is unchanged by every patch: `storage` was required already, `storage.sync` adds no permission, no
  install or update warning, and no `connect-src` (Sixkey makes no request: Chrome syncs).

## 15. Tests and mutants

At `648772b`: 363 unit files, 6,355 passing cases (4 expected failures, 1 skipped); 20 browser spec files on the e2e and
store builds, one worker, 145 passing. The backup's own: unit `csb-slots`, `csb-area`, `csb-read`, `csb-worker`,
`csb-pages-dom`, `csb-firstrun-dom`, `csb-popup-dom`, `csb-check-dist` (and `csb-notes`, these notes' names); browser
`test/e2e/csb-probe.spec.ts`, `test/e2e/csb-worker.spec.ts`, `test/e2e/csb-pages.spec.ts` (two and three profiles: a
copy handed over, found, restored by password and by recovery key, arriving in pieces, a held merge, a full space merged
and freed), `test/e2e/csb-card-visual.spec.ts`, `test/e2e/csb-popup.spec.ts`; with `source-rules`, `cloudbk-status`,
`read-budget`, `budget-split`, `cloudbk-check-dist`, `m5-build-guard`, `firstrun.spec.ts`, `store-backup.spec.ts` and
`perf.spec.ts` updated. At CSB-R: 345 unit files, 5,887 passing (4 expected failures, 1 skipped), the 19 that went with
the Drive path removed (section 16); every browser spec file (71), one worker, 556 passing and 7 skipped (the
measurements and the screenshots, which run on request).

Each patch's author ran mutants: one text replaced, the named tests run, the file restored byte for byte and its SHA-256
checked after each run and at the end. Every mutant below was killed by the assertion written for it, unless said.

| Patch | Mutants |
|---|---|
| CSB-0 | check-dist's store-build rules: eleven mutants built into `cloudbk-check-dist` and one in `m5-check-dist` (the plugin's ID in the store build's `externally_connectable`). The author's runs: seven killed, and two meant to live did (a control on the first round's tree, and an equivalent) |
| CSB-1 | 102 in the first round, all killed (one lived first: a chunk count of 0 refused only through the length's bound; a case was added); 119 in the second, all killed |
| CSB-2 | 66 unit and 4 against the probe in the first round; 101 unit and 6 against the probe in the second, all killed. Four lived in first runs and were gaps in the tests, filled before the final runs: a slot id with a dot, a page's bare import of the writer, a key that reads as a chunk through its `toString`, and a read owed when the watch stops |
| CSB-3 | 56 in the first round; 78 in the second (the 56 moved to the new code, and 22 new: the lock order, the adoption's checks, the stale checks, the numbers after the lock), all killed (one lived first: a fork's leftovers looked for under the old slot, which the writer's own check refused, so nothing changed in the area; the fork tests now check that the write went through); and two browser mutants (a write before the debounce), killed |
| CSB-4 | 34 unit and one browser in the first round; 36 more and six from the independent review in the second, and two browser mutants, all killed |
| CSB-5 | 35 in the first round (12 run again after a change of the pill's markup) and four browser mutants (one lived first, the pill not using the open's read: the spec now counts the gets); 50 in the second, 14 from the independent review, and 8 browser mutants, all killed |
| CSB-6 | `csb-notes`, 14 mutants, all killed: nine of these notes (a message renamed, a field dropped from a record and from the manifest, an optional mark dropped, a number changed, a row dropped, two unknown keys named, a file renamed) and five of the code (a message added, an optional field added to the link's reader, a margin changed, an alarm renamed, a handler calling a method the worker does not have) |
| CSB-R | 19 in the first round, all killed: `backups.transport` offered again, and listed under Sensitive again; check-dist looking for none of the Drive path's marks, and for each of ten of them left out, letting a `devcloud/` folder ship, letting `identity` in, letting a catalog entry hold `backups.transport`, allowing the worker a second `fetch`; a row for one of the Drive path's messages again; a Google host named in the source. 25 in the second, all killed: the first round's again (the marks narrowed, so the two that were words are gone); an earlier version's stored approval read without the retired capability, the retired capability held, any name of version 1 accepted in a stored descriptor; the catalog rule looking at official entries only, the marks not looked for in the developer build; and "Google Drive", 云端硬盘 or Google's sign-in host made a mark again |

## 16. The removal of the Google Drive path (CSB-R)

Done in CSB-R: the Drive path, unwired in every build since CSB-3 and shown by none since CSB-4, is removed. It was
subtractive; nothing of the backup in Chrome sync depended on it. What it removed or changed:

- The plugin: `plugins/official/cloud-backup/` whole; the cloud entry of `plugins/catalog.json` (which now lists no
  plugin) and `plugins/catalog.test.json`; `scripts/cloud-plugin.mjs` (the gates of Sixkey's own store package,
  `storeIdGate` and `idDraftGate`, and the ID draft's names moved to `scripts/store-gates.mjs`, the plugin's side taken
  out); `scripts/google-oauth.mjs`; the build's cloud-entry check, its guard of the developer cloud page, its plugin that
  dropped the hidden pages' chunks, and the defines `__GOOGLE_CLIENTS__`, `__CLOUD_PLUGIN_ID__`, `__CLOUD_DEV__`,
  `__CLOUD_FAKE__`, `__CLOUD_UI__`, `__DRIVE_ORIGIN__`; `scripts/package.mjs` `providerGate`; `npm run
  build:cloud-plugin`.
- The core and the platform: `src/core/cloud/drive.ts`, `provider.ts`, `remote.ts`, `rules.ts`; `src/platform/`
  `cloud-provider.ts`, `cloud-ask.ts`, `cloud-config.ts` (the Drive path's two records, which no released build wrote:
  nothing migrates or clears them), `cloud-fake.ts`, `cloud-google.ts`, `cloud-names.ts`, `cloud-worker.ts`,
  `google-auth.ts`, `google-connect.ts`, `google-transport.ts`, `devcloud-worker.ts`, and `src/devcloud/`; in
  `src/core/cloud/status.ts`, the Drive path's errors, its stopping set, `cloudStatus` and `popupSpeaks`, which
  nothing used (the popup's own rule is `csb-config.ts` `backupRuns`).
- The pages and their text: `src/options/cloud/` whole (its `file.ts`, which opens a downloaded copy, moved to
  `src/options/csb/file.ts`); `src/ui/cloud-text.ts`, `src/ui/cloud-popup-text.ts`; the `cloud-*` and `cloud-popup-*`
  catalogs, `scripts/i18n/cloudbk.py`, `cloudpopup.py`, `cloud_plugin.py`, and their views and budgets in
  `scripts/messages.py`, the build, `scripts/catalog-keys.mjs`, check-dist and `budget-split`; the Drive card's styles.
- The messages: the twelve `sk-cloud-*` rows of `sender-policy.ts`, `CLOUD_MESSAGES`, `DEVCLOUD_MESSAGES` and the
  developer cloud page's surface; `sw.ts`'s check of them (`isCloud`) and its `serveDevCloud`; `src/options/Misc.tsx`'s
  `sk-cloud-purged`.
- The developer manifest's Google `connect-src` paths and optional `identity`: every build's CSP names the API origin
  alone (and the site rules' path with the updater's gate open); no build has `identity` or `oauth2`. The store and the
  e2e manifests are unchanged.
- The core's handling of the `backups.transport` capability: no plugin is offered it (`descriptor.ts`
  `OFFERED_CAPABILITIES`), so a descriptor that asks for it has it dropped and listed in `unavailable`, and no new
  approval grants it, at any level, whatever a catalog's ceiling says (`test/unit/plugins-w2b.test.ts`). An approval an
  earlier version stored with it (a developer's profile that approved the cloud plugin) is not turned away: the
  capability is retired (`RETIRED_CAPABILITIES`), so the grant record still reads, as stored, and the other plugins'
  approvals keep working, while `policy.ts` `heldNow` drops it, so no plugin holds it; any other name a stored
  descriptor holds that this version does not offer still makes the record damaged (`test/unit/plugins-grants.test.ts`).
  It is no longer in `policy.ts`'s list of what a listed plugin never holds, nor on the approval screen (its line, its
  text `pxCapBackupTransport`). The SDK contract still declares it (`contract/plugin-sdk`), a name of version 1 this
  Sixkey does not offer: it goes with the plugin platform's own decision; the SDK's text says it is not offered.
- Tests: the unit files `cloud-*.test.ts` and `cloudbk-*.test.ts` but `cloudbk-format`, `cloudbk-restore`,
  `cloudbk-status` (now the backup in Chrome sync's status alone) and `cloudbk-service`; `test/helpers/fake-drive.ts`;
  the source-rule, check-dist and `m5-build-guard` rows that held the Drive path.
- Docs: PRIVACY.md's sentences on the plugin and the Drive path's two records; ARCHITECTURE.md's official cloud plugin
  section, the developer cloud page's row and those records' rows; the first store uploads' steps, which the plugin's
  README held, in `extension/README.md`, "Publishing", Sixkey's alone.

What stays, and why:

- Names from the Drive era that the backup in Chrome sync uses: `src/platform/cloud-go.ts` and its key `sk_cloud_go`,
  `src/platform/cloud-mark.ts`, `src/core/cloud/format.ts` (`sixkey-cloud-backup`, the format of a downloaded copy and
  of every slot's text), `restore.ts`, `status.ts`, and `test/helpers/cloud.ts`. Not renamed: nothing requires it, and
  `sk_cloud_go` is in PRIVACY.md's key list. `createSchedule` (`csb-worker.ts`) has one user now and stays as it is.
- check-dist's refusals that guard every build, converted from the Drive path's: no manifest has `identity`, required
  or optional, or `oauth2`, and the CSP is exactly the API origin's; no shipped text file names Google's API and OAuth
  endpoints or Drive (`googleapis.com`, `accounts.google.com/o/oauth2`, `drive.google.com`) or carries a mark of the
  Drive path (the fake Drive, the developer cloud page and its message, `sk-cloud-`, the two records' keys, the sign-in
  token's), the developer build included; no `devcloud/` folder ships; and no plugin catalog entry, whatever its trust,
  may hold `backups.transport`. These are endpoints and the path's own names, not words: text naming Google or its
  Drive, and a site rule for Google's sign-in page (`accounts.google.com`), pass. The worker keeps its one `fetch` (two
  with the updater's gate open), and any URL in a minified script but the API origin's still fails, Google's included.
  `test/unit/csb-check-dist.test.ts`, `m5-check-dist.test.ts` (the developer build) and `m5-build-guard.test.ts` hold
  each.
- The store package is still refused, for its other two reasons: Sixkey's `STORE_ID` is empty, and the site rules'
  bundle names no source.
- Old alarms of the Drive path that a developer's profile may still hold run nothing (`csb-worker.test.ts`,
  `m5-sw-wiring.test.ts` keep those names), and a page that still sent one of its messages gets no answer
  (`autofill-pre-sender.test.ts`).
