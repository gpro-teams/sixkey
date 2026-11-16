# C6 (H2 export selected accounts + H3 master password before every export) review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading, repository paths updated to the current layout and absolute local paths
> shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Review only: nothing in the main tree was changed except this file.
> Patch: `phase0x/C6/C6.patch` (10 files), applied with `patch -p1` to a scratch copy of the main tree
> (`…/scratchpad/c6-review/`). The patch's base is byte-identical to the main tree.
> Spec: PHASE0X-PLAN C6, §0, appendices B and D; SYNC-DESIGN §9.1 H2/H3, review H-d, Z3, item 62;
> research/fingerprint-browser-security-lessons.md; A3-REVIEW (verifyPassword, recordExport, clearSecurityLog, A3-4).
> Reviewer's own tests (scratch only, all passing on the clean patched tree), under
> `scratchpad/c6-review2/extension/test/`:
> - `unit/zz-c6-review.test.ts`: the adversarial fuzz, the import property, and the H3 bypass at service level;
> - `unit/zz-c6-kill.test.ts`;
> - `e2e/zz-c6-review.spec.ts`: R1–R9;
> - `e2e/zz-c6-enter.spec.ts`.
>
> Mutation script: `…/scratchpad/c6-mut.py`. Results: `…/scratchpad/c6-mut-core.json` and `c6-mut-ui.json`.

## Numbers (re-run in the scratch copy)

| Claim | Confirmed |
|---|---|
| typecheck clean | yes (`npm run verify`, exit 0) |
| 1007 unit tests | yes: 57 files, 1007 passed, 1 skipped |
| 75 e2e | yes: 75 passed (6.8 min) |
| popup +286 B | yes, exactly: 56,921 B on base, 57,207 B patched (static +17 B, zh_CN catalog +269 B); check-dist prints 55.6 → 55.9 KB of 60 |
| 24 mutants, 23 killed, 1 equivalent | per the implementer's logs (`phase0x/C6/logs/mut-*.log`, `mut-*.json`; list in `phase0x/C6/scratch/mut.py`: 14 core, 10 UI). Not re-run by the reviewer. The one equivalence (`totp-counter`) was checked by reading the code: `addEntry` drops a counter on a TOTP entry (`ops.ts:67`). The reviewer's own 20 mutants are in C6-3 |

## Findings

### C6-1 (High): H3 can be bypassed in two clicks outside the Backup panel: "New recovery code" asks for nothing

**Where:** `src/options/Security.tsx:76` calls `rt.service.newRecoveryCode()` without a password.
`src/core/service/service.ts:643` needs only an unlocked session (`requireVk`). Neither file is in the patch. The patch
does add the promise this breaks: `expPwLead` ("Every export asks for your master password again, even while Sixkey is
unlocked"), shown in Settings › Backup and as a fixed line in Security mode (`SecurityMode.tsx:100`).

**Failing sequence.** This is the scenario of SYNC-DESIGN item 62: a colleague at an unlocked shared profile. Reproduced
end to end in the real UI (e2e R2) and in the service (unit test "H3 can be bypassed").
1. In Settings › Security, press "Create new recovery code". No password is asked, and the new code is shown with Copy
   and Save-as-file.
2. In the popup, press Lock, then "Use recovery code", then "Set a new password". Enter the code and a password of the
   attacker's choice, then "Reset and unlock".
3. In Settings › Backup, type that password into `#export-pw` and press Save plain list. The file holds every seed
   (R2 asserts it contains `SECRET`).
4. The owner is locked out. Their master password is replaced (`verifyPassword(STRONG)` gives `wrong_secret`) and their
   recovery code is void.
5. With the password they just set, the attacker can also call `clearSecurityLog` (A3-1's gate). That erases
   `recovery_code_new` and `password_reset`. What is left is `["log_cleared"]` with a count of 0, checked in the unit
   test. So the bypass defeats H6 as well as H3: both halves of item 62 fall.

**Quieter variant.** Do step 1 only, and take the new code away. A vendor-synced or copied profile carries the keyring,
so the code unlocks that copy anywhere. The owner's password keeps working here. The only trace is a
`recovery_code_new` line in the security log, and the owner's own code silently stops working.

**Fix:**
- In the service, `newRecoveryCode(password: string)` first calls `await this.verifyPassword(password)`, so a wrong
  password is refused and recorded.
- In the UI, the "New recovery code" box gets a password field, as the rotate-key box beside it already has (`#rot-pw`).
- Tests:
  - unit: no password or a wrong one is refused, and a wrong one is recorded once;
  - e2e: R2 must fail at step 1.
- Ownership: `service.ts` is lane A (A3 is merged; a small sequential edit), and `Security.tsx` is C5 → C7.

**Blocks merge:** yes, in the A3-1 sense. Either of these satisfies it:
- the fix lands with C6, with owner sign-off on touching those two files;
- the integrator writes it into C7's acceptance criteria before C7 starts. C7 is the next owner of `Security.tsx`.

Until then, H3 is not done, and SYNC-DESIGN item 62 ("已修复") is not true.

### C6-2 (Medium): the file can hold an account the page no longer lists, or content it never showed

**Where:**
- `Backup.tsx:127-128` exports every id in `picked` that is alive in the fresh read. The count (`:51`), the button
  label and the preview count only the ids the page lists.
- `SubsetPicker.tsx:26-27` drops ids that are no longer listed, but only when a tick changes. A reload alone keeps them
  in `picked`.
- The options page does not reload on storage changes.

**Failing sequence (e2e R7, reproduced):**
1. Tick GitHub and AWS.
2. In the popup, delete AWS to the trash.
3. This page reloads for its own reason (an account added on its Add panel). AWS leaves the list. The page says
   "1 of 2", the button says "Save 1 account(s)", and the preview lists GitHub only.
4. A second settings tab restores AWS from the trash. This page does not change.
5. Type the master password and the file password, then press Save.
6. The file holds **AWS and GitHub**. Only the message afterwards says "File with 2 account(s)".

**Variant:** a rename, a group change or new remembered sites made in another page after this page loaded go into the
file, which then holds names, a group name or domains the page never showed. `SubsetPicker.tsx` (top comment) promises
"the file never holds more than this list shows". The H2 text promises "对方只会得到这几个账户" (they get only these
accounts). Both fail here.

**Fix (about 10 lines in `Backup.tsx`):**
1. Export the accounts the page shows, not `picked`:
   - Let `shown = selectedEntries(vault, picked)`.
   - In `make`, let `fresh = selectedEntries(v, shown.map((e) => e.id))`.
   - If `fresh.length !== shown.length`, or any shown field differs (issuer, label, group, domains), throw a CHANGED
     sentinel. Handle it as `NONE_LEFT` is handled: `reload()` and a message such as "these accounts changed since this
     page loaded: check the list again".
2. Optionally prune `picked` whenever `vault` changes:
   `useEffect(() => setPicked((p) => new Set(aliveEntries(vault).filter((e) => p.has(e.id)).map((e) => e.id))), [vault])`.
3. Add R7 as a regression test.

**Blocks merge:** yes. This is the package's one named high-consequence property (plan C6 "风险"). The sequence is
unusual, but the fix is small.

### C6-3 (Low; blocks merge as a test gap): rules the patch states that no test pins

**The run.** 20 mutants, none of them in the implementer's list of 24. Script: `…/scratchpad/c6-mut.py`.
- The 10 core mutants each ran `backup-subset.test.ts`, then the reviewer's unit tests.
- The 10 UI mutants each ran `build:e2e`, then `export.spec.ts` with `flows.spec.ts -g 'export|backup'`, then the
  reviewer's R-specs.
- Each file was restored and checked by hash. The mutated copy's `src` is identical to the implementer's patched work
  tree afterwards.

**Result:**
- The implementer's suite killed 10 of the 20.
- Of the 10 survivors, 8 are killed by the reviewer's tests, which pass on the clean patched tree.
- The other 2 are equivalent in Chrome (measured).

| Mutant | What it breaks | Implementer's tests | Reviewer's tests |
|---|---|---|---|
| r-vaultid-derived | vault id derived from the source's | killed | killed |
| r-ids-derived | entry ids derived from source ids | killed | killed |
| r-src-wall | hlc wall time from the source's newest edit | killed | killed |
| r-other-group | an ungrouped account gets another group's name | killed | killed |
| r-spread-source | entries copied by spreading the source (tombstone fields, order) | killed | killed |
| r-sel-trash-too | selection includes trash | killed | killed |
| r-unused-once | a repeat is not drawn again | killed | (not targeted) |
| r-hotp-counter-zero | HOTP counter reset to 0 | killed | killed |
| **r-taken-alive** | new ids avoid live ids only, not a tombstone's (`subset.ts:97` says "even a tombstone's") | **survived** | killed by `zz-c6-kill` |
| **r-devices-no-dhlc** | the new device avoids hlc/phlc devices only, not dhlc | **survived** | killed by `zz-c6-kill` |
| **u-subset-stale** | the subset path builds from the page's stale vault (flows covers only encrypted and plain) | **survived** | killed by R6 |
| **u-samepw-no-nfkc** | the same-password check without NFKC | **survived** | killed by R5 (full-width master password) |
| **u-device-trust-page** | the device-key branch trusts the page and skips `verifyPassword("")` | **survived** | killed by R1 (stale page, password turned on elsewhere) |
| **u-device-catch-all** | the device-key branch lets any error through | **survived** | killed by R1 |
| **u-picker-trash** | the picker lists trash too, and a group tick takes trashed accounts | **survived** | killed by R8 |
| **u-record-first** | the export is recorded before the file is made (a selection gone at export time is still recorded) | **survived** | killed by R9 |
| u-retry-wrong | a wrong password is checked and counted twice | killed | (not targeted) |
| u-plain-old-gate | the plain button is enabled without the master password and its click guard is gone | killed | (not targeted) |
| u-subset-enter | the `if (!canSubset) return` guard removed | survived | survived: **equivalent** |
| u-encrypted-enter | the `if (!canEncrypted) return` guard removed | survived | survived: **equivalent** |

**Why the two Enter mutants are equivalent.** HTML implicit submission does not submit a form whose default button is
disabled. Measured in this Chrome (`zz-c6-enter.spec.ts`): Enter in `#subset-pw2` or `#backup-pw2` with the button
disabled fires 0 `submit` events; with the button enabled it fires 1 and the file downloads. Consequences:
- The guards are harmless defence in depth. Keep them.
- The comment at `Backup.tsx:111` ("Enter in a field submits the form whatever the button shows") is wrong. It should
  say that the guard is defence in depth.
- The implementer's "nor by Enter in a form" step proves only that the disabled button holds.

**The brief's other named examples:**
- **"Wrong password counted twice":** u-retry-wrong is killed by the implementer's suite.
- **"Wrong password counted not at all":** no page-level mutant can cause this without also opening the gate, because
  the service records inside `verifyPassword`. That belongs to A3's suite (A3-3).
- **"Plain export without the password through the keyboard path":** the plain button sits in no form. The only
  keyboard path is the button itself (Space or Enter on it), and a disabled button ignores both. u-plain-old-gate
  re-opens it and is killed.
- **"Subset export marking Last backup":** killed by the implementer's own `subset-marks`, and its `sk_last_backup`
  assertion is real.

**Other test notes:**
- **The raw-text scan in the e2e test proves little.** In `export.spec.ts` (`for (const x of [...]) expect(text).not.toContain(x)`)
  `text` is ciphertext, so the scan holds trivially. The decrypted checks after it are what count.
- **The unit property's tokens are pure ASCII and never shared.** It cannot see escaping bugs, or an unselected
  duplicate that shares a selected account's issuer or secret. The reviewer's fuzz adds both, and it passes.
- **One patch claim is pinned by no test:** "the file never holds more than this list shows" (C6-2).

**Fix:**
- Add R1, R5, R6, R7 (once C6-2 is fixed, as a regression test), R8 and R9 to `export.spec.ts`, and `zz-c6-kill`'s two
  cases to `backup-subset.test.ts`. They are in `…/scratchpad/c6-review2/extension/test/` and use only
  `harness.ts` / `export-helpers.ts` helpers.
- Fix the comment at `:111`.

**Blocks merge:** yes. The tests are cheap and already written.

### C6-4 (Low): an export started twice in one task runs twice

**Where:** `Backup.tsx:82-84`. `busy` and `exportPw` are read from the render's closure. Three synchronous
`button.click()` calls in one task all pass the guard (e2e R4, measured):
- with a wrong password: 3 `unlock_failed` entries;
- with the right one: 3 files and 3 `export_plain` entries.

A real double click is safe: two tasks, Preact re-renders in between, and the second click lands on a disabled button
(R4 measured 1 file). Only a script on the page can do this, and such a script can already do worse (A10).

**Fix:** guard with a ref, set before the first `await`: `const inFlight = useRef(false)`.

**Blocks merge:** no.

### C6-5 (Low): recording order, and a failing "Last backup" write after a saved file

**Where:** `Backup.tsx:91-94`.
- **Order.** `recordExport` runs after `download()`. Closing the tab right after the click can leave a saved file and no
  record. A3-9's rule is "record once the step is proven, before its effect".
- **Late failure.** `markBackedUp` can reject after the file is saved. The page then shows an error. It keeps the file
  password fields (they are cleared only on success, `:112` and `:130`), and it says nothing about the file already
  saved. A retry makes a second file and a second record.

**Fix:**
- Order the steps verify → `read` → make → `recordExport` → `download` → `markBackedUp`.
- Catch `markBackedUp` on its own (diagnostics line) and still report success.

**Blocks merge:** no.

### C6-6 (Low): a typed master password waits in `#export-pw` indefinitely

**Where:** `Backup.tsx:43` (state) and `:199` (field).

**Sequence.**
1. The owner types the master password into `#export-pw`.
2. They leave without exporting.
3. The password stays in the field and in component state, with nothing to clear it:
   - **Across a lock from the popup.** The options page does not reload on storage changes, so the box stays visible
     and filled. An export attempt while locked fails at `read()`. After the next unlock on this page (`reload()`;
     Backup stays mounted), the field is still filled.
   - **Across tab switches.**
4. Whoever sits down next at the unlocked browser presses Save.

This is the H3 scenario again, made easier by the owner.

**Fix:** clear `exportPw` when `unlocked` turns false, on `visibilitychange` to hidden, and after about 60 seconds
without input.

**Blocks merge:** no.

### C6-7 (Info): the preview does not say that groups and remembered sites go with each account

The file keeps each account's `group` and `domains`, as the plan specifies ("这是用户选中账户的内容"). The page shows
groups only as list headings, and it never shows domains. A domain can name an internal host (`admin.corp.example`).

**Where:** `SubsetPicker.tsx:61-68` (the preview shows names only) and `subset.ts:46` (`contentOf` keeps `group` and
`domains`).

**Sequence:**
1. An account remembers the site `admin.corp.example`.
2. Tick it. The preview shows only "GitHub / alice".
3. The file carries the domain and the group name.

**Suggestion:** a line under the preview, such as "Each account goes with its group and remembered sites", or show them.

**Blocks merge:** no.

### C6-8 (Info, for M2): every profile restored from the same subset file has the same vault id

Two colleagues restore one file. Both vaults now have the file's vault id. A later full backup from one, imported into
the other, then **merges** (deletions and edits included) instead of adding. Once sync exists, this is SYNC-DESIGN
I6/§3.5 ("the same vault under another key"), moved from the source to the recipients. The source side is handled: the
id is new on every export.

**Where:** `service.ts:679` (same vault id: merge) and `subset.ts:99` (the id is random per export, then kept by
Restore, `service.ts:667`).

**Sequence:**
1. Profiles P1 and P2 both restore `sixkey-selected-….json`.
2. P1 trashes an account, then saves a full backup.
3. P2 imports it. Merge mode trashes the account in P2 as well.

**Suggestion:** a note for M2. A real fix needs a marker in the file, and that is a format change the budget rule
excludes now.

**Blocks merge:** no.

### C6-9 (Info): what still links or marks a subset file

The subset.ts header lists what links two files: the shared accounts and the export time. Three more points:
- **Size.** The ciphertext length is a deterministic function of the selected content, because there is no padding.
  Someone without the password can tell that two files probably hold the same selection. Full backups have the same
  property.
- **Recognisable as a subset.** Every `createdAt` and every hlc wall time equals `created`, and the file name is
  `sixkey-selected-YYYYMMDD.json`.
- **List order.** The order keys and the hlc counters carry the source's list order (documented).

The reviewer's tests confirm that nothing else links a file to the source vault or device. See "Sound" below.

**Where:**
- `backup.ts:37`: no padding before AES-GCM;
- `subset.ts:89-90`: one instant for every stamp;
- `Backup.tsx:129`: the file name;
- `subset.ts:32-34`: the header's list of what links two files.

**Sequence:** export the same selection twice. The two ciphertexts have the same length, and both files are visibly
subsets.

**Suggestion:** add "and roughly its size" to the subset.ts header and later to PRIVACY.md (D).

**Blocks merge:** no.

### C6-10 (Info): file ownership

`src/options/SecurityMode.tsx:99-100` is C5's exclusive file (appendix B). C6 adds two lines to it (`#sm-export`). The
alternative, an `expPwLead` line inside Settings › Backup only, would satisfy H3/Z3 just as well. The integrator should
record the deviation or ask C5's owner.

## What is sound (checked, with evidence)

### Privacy of the subset file (`src/core/backup/subset.ts`)

The mandatory focused review. Result: **sound.** Apart from C6-2, which is in the page and not in subset.ts, no way was
found for an unselected value to reach the file.

**The allowlist fails closed, three times over.** A value reaches the file only through all three of these:
1. `contentOf` names every field (`subset.ts:46`).
2. `addEntry` builds the entry from a literal (`ops.ts:62-70`).
3. The result is read back through `parseEntry` (`validate.ts:55-69`), which also builds from a literal.

So a field added to `Entry` reaches the file only if all three are edited. A new *required* field of `NewEntry` is a
compile error in `contentOf`. Unknown fields on a source entry never get past `parseEntry` in the first place. The
reviewer's mutant `r-spread-source` (copy by spreading the source entry) is killed by both suites.

**Selection.**
- It goes through `aliveEntries` (`subset.ts:77`):
  - out: trash and erased entries;
  - in: an entry edited after its delete (alive, as the popup lists it), and a crafted `deleted: true` with no `dhlc`
    (alive in both places).
- Unknown ids and repeated ids are ignored.
- An empty selection throws, so there is never an empty file.

**Every non-content value is fresh:**
- the vault id: 128 random bits, never the source's;
- the entry ids: v4 UUIDs, never any source id, even a tombstone's (pinned only by the reviewer's `zz-c6-kill`, see C6-3);
- one device id per export: the same generator and format as real devices (`vault/hlc.ts newDeviceId`), never a device
  of the source;
- `createdAt`, the hlc wall and the phlc wall: all the export time;
- order keys: `spread(n)`.

**The stamps depend only on n.** Checked at n = 260, where `addEntry`'s own rebalance fires once. A shuffled source and
an unshuffled one give identical order keys, hlc counters and phlc counters.

**A random source that repeats.** `unused()` draws again up to 8 times, then fails loudly.

**Group names.** A group name comes only from a selected live account. A purged tombstone keeps its group
(`purgeEntry`), but that name never appears. The fuzz gives purged entries their own tagged groups to check this.

**The envelope** holds only these keys:
- `format`, `v`, `created`, `app`, `iv`, `ciphertext`;
- `kdf` = {`name`, `hash`, `iterations`, `salt`, `v`}, with a new salt each time.

The decrypted bytes are exactly the canonical serialisation of the parsed vault. The reviewer decrypts by hand with
AES-GCM and the AAD, so nothing can hide in the bytes beyond what the parser keeps.

**No metadata elsewhere:**
- the file name holds only the date;
- the page DOM holds names only: no ids, no secrets, and the input values are properties, not attributes;
- errors go to diagnostics as codes only (`ui/errors.ts:99`).

**The reviewer's adversarial fuzz** (`zz-c6-review.test.ts`):
- **The vaults.** They are built by real operations from three devices: add, edit, setGroup, move, delete, restore and
  purge. Another device edits after a delete, and the copies are merged. Duplicates of selected accounts share their
  issuer and secret.
- **The names.** They include quotes, backslashes, control characters, RTL and zero-width characters, combining marks,
  emoji, CJK and `</script>`.
- **The selection.** Random ids, dead ones included, plus ids that match nothing, repeated ids, the vault id itself,
  and a "whole group in any state" pick.
- **The output-side rule.**
  - Every string and number in the subset vault is either content of a selected live account or a fresh value.
  - Every source id and stamp, every source device, the source vault id, and every tagged value unique to an unselected
    or dead entry is absent from the decrypted text, both raw and JSON-escaped.
- **The runs.** 600 vault runs, 12 encrypted-file runs, 150 runs checking that two files of the same selection share
  only content and the n-determined keys, and 15 import runs.
- **What the generator produced** over 500 samples:
  - 647 trash entries, 1,067 purged, 988 alive again after a delete, and 905 marked deleted with no `dhlc`;
  - 542 dead entries selected, against 1,720 live ones;
  - vaults of up to 37 entries.
- Everything passes on the patched tree.

### H3: the master password before every export

**Every export path goes through the same steps.** All three exports go through `exportWith` → `confirmed` →
`verifyPassword` → a fresh `read()` → make → `download` → `recordExport`, as the plan orders them.
- `verifyPassword` checks the keyring as stored now, never the session. A stale page, a cached session and "lock every
  time" (the key in this page's memory) cannot skip it.
- The buttons stay disabled until the field is filled.
- Enter in either form cannot submit while the button is disabled: HTML implicit submission is blocked, as measured, and
  `if (!canX) return` is a second guard (C6-3).
- An empty field never reaches the service, which agrees with A3-4 as fixed: `verifyPassword("")` gives
  `empty_password` and records nothing.
- A wrong password is recorded once, by the service and not by the page (e2e: +1 for each button).
- The field is emptied at the start of every attempt, and focus returns to it after a wrong password.

**The device-key branch** is only a display hint. The service decides.
- R1 runs the race: a stale page shows "no password", another page turns the password on, and the stale page's export
  makes no file and no record, then reloads and asks.
- `verifyPassword("")` on a protected vault rejects with `empty_password`, not `not_protected`, so the page refuses.
- No keyring can hold both a device wrap and a password wrap: `rekey` builds without a device wrap (`keyring.ts:265`).

**The password lands nowhere (R3).** After a wrong password and a right one, it is in none of these:
- `chrome.storage.local` (which holds the security log) or `chrome.storage.session`;
- `localStorage` or `sessionStorage`;
- the URL or `outerHTML`;
- the diagnostics download.

**The other export-like paths** found in the options and popup code:
- The diagnostics download holds events and codes only.
- The popup copies codes, not seeds.
- No page shows a secret or a QR code.
- The recovery-code file is part of setting a code up.

The one exception is C6-1.

### Round trip and the relaxed re-import rule (H-d)

**Restore** in a profile with no vault goes through the wizard, which prepares keys for the file's vault id
(`FirstRun.tsx:99`). Keys made for another id are refused (`service.ts:667`, and a unit test).

**Import into an existing vault** uses added mode (`service.ts:685-693`). It only appends:
- The reviewer's property test checks every entry the receiving vault held before. Each is byte-identical afterwards,
  and the counts match `added`.
- The test's receivers already hold some of the same accounts, some renamed, and some HOTP accounts with a counter
  further on.
- An existing HOTP account is skipped, so its counter is never lowered.
- A renamed account comes in as a second entry with the file's counter (the H-d relaxation). It is acceptable: nothing is
  lost or overwritten, and the duplicate is visible.

**Merge mode** happens only in a profile that was restored from that same file.
- It gives no duplicates.
- It cannot bring back what the receiver deleted or erased: the newer `dhlc` wins, and a purged entry stays dead.
- No way was found for a subset file to delete or overwrite an account in another vault.

### Same-password refusal (NFKC)

**Necessary.** The file password goes to other people, and the H2 audience is exactly the vendor-synced profile. A
synced copy plus the master password opens the whole vault.

**Sound:**
- It compares by NFKC, as `normalizePassword` does (`kdf.ts:41`).
- It compares against the very value that `verifyPassword` checks in the same click. So at export time, "differs from
  what was typed" means "differs from the master password".
- A full-width spelling is refused (R5).

**Consistent with the full backup.** The full encrypted backup may use the master password because that file is for the
owner. That fits the product promise.

### "Last backup" and the recording rules

- Only the full encrypted export and the plain export set `sk_last_backup`. The subset export does not (`Backup.tsx:94`).
- The e2e check on that key is real: `setLastBackup` writes `sk_last_backup` (`types.ts:82`).
- `recordExport` never throws, and its kinds are fixed.
- An export that fails before its file is made is not recorded. The order around `download` is in C6-5.

### The rest

- **SubsetPicker:**
  - names only, no secret and no code;
  - a group tick takes the accounts listed now, not ones added to the group later;
  - the tri-state group box works (e2e).
- **Text:**
  - all keys carry the `exp` prefix;
  - existing keys are reused (`lockedTitle`, `passwordLabel`, `deviceOnlyTitle`, `noMatches`, `ungrouped`, `emptyTitle`);
  - the no-dead-text test passes.
- **Hard rules:** no new permission, no new network, no new format.
- **Migrated selectors:** the e2e selectors stay as appendix D lists them. The new ones (`#export-pw`, `#subset-*`,
  `#sub-*`, `#sm-export`) are additive.

## Verdict

**MERGE AFTER FIXES.**

**subset.ts itself is sound.** Its allowlist fails closed, every non-content value is fresh, and no path was found for an
unselected or dead value to reach the file. The H3 gate inside Settings › Backup is also sound on every path, the
device-key branch and the stale-page race included.

**What must happen before merge:**
- **C6-2:** the page can export an account it no longer lists, or content it never showed. About 10 lines in
  `Backup.tsx`.
- **C6-3:** the tests that pin those rules, and the subset-specific stale-page, NFKC and device-race behaviour.
  Already written.
- **C6-1, in the A3-1 sense.** H3 as a promise is broken by the ungated "New recovery code". Either the fix lands with
  C6, with owner sign-off for `service.ts` and `Security.tsx`, or the integrator writes it into C7's acceptance
  criteria before C7 starts. Until one of these happens, H3 cannot be declared done, and SYNC-DESIGN item 62 is not
  fixed.

**Counts:** High 1 (C6-1), Medium 1 (C6-2), Low 4 (C6-3, C6-4, C6-5, C6-6), Info 4 (C6-7 to C6-10).
Blocks merge: C6-1 (as above), C6-2 and C6-3.

**Top 3:**
1. **C6-1 (High).** Settings › Security › "Create new recovery code" asks for no password. Then Lock, then "Use
   recovery code" and "Set a new password", then export: every seed leaves without the owner's master password, and the
   owner is locked out. This is proven in the real UI (R2).
2. **C6-2 (Medium).** The file can hold an account the page no longer lists (R7: the page said "Save 1 account(s)" and
   the file held 2), or names, group or domains changed in another page since this page loaded.
3. **C6-3 (Low, blocks as a test gap).** The implementer's suite misses 8 of the reviewer's 20 mutants: the stale vault
   in the subset path, NFKC, both device-branch shortcuts, trash in the picker, recording before making, and the two
   tombstone-collision claims. All 8 are killed by the reviewer's tests. The 2 Enter mutants are equivalent (implicit
   submission is blocked by a disabled button).

**For D (PRIVACY.md and SECURITY.md):**
- `PRIVACY.md:24` lists only the encrypted and plain exports. Add "Export selected accounts" and the rule that every
  export asks for the master password.
- Note the C6-9 linkability points: the file's size, and that a subset file is recognisable as one.
- Add the C6-8 note on a shared vault id across recipients to the M2 handover.
