# A4 review: the G-M2 gate fixes (service and store layer)

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the reviewer line, repository paths updated to the current layout and absolute local
> paths shortened, and two line numbers into PHASE0X-PLAN moved with its new banner. Paths under `scratchpad/` were
> the reviewer's temporary working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists
> only as far as this record quotes it or as it was adopted into the test suite. What became of each finding:
> [`docs/audit/INDEX.md`](../INDEX.md); how to read these records: [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Reviewer: a Claude Opus review session. Review only: nothing in the main tree was changed except
> this file, and nothing was committed.
>
> **Patch**: `phase0x/A4/A4.patch`, 25 files. It applies cleanly with `patch -p1` to a scratch copy of the main tree, and
> the patch's `base/` is byte-identical to main. `scripts/messages.py` regenerates `_locales` exactly as in the
> implementer's copy.
>
> **Spec**
> - docs/audit/internal-reviews/GM2-REVIEW.md: GM2-1 … GM2-16, the crash matrix, Appendix D;
> - docs/SYNC-DESIGN.md §0.0i (revision 9: the GM2-4 / GM2-5 decisions and the eleven M2 storage requirements) and §0.0h;
> - docs/audit/internal-reviews/A2-REVIEW.md, docs/audit/internal-reviews/A3-REVIEW.md.
>
> **Scratch** (session-scoped): `scratchpad/`
> - `a4-review/`: main + A4. The full verification ran here.
> - `a4-base/`: main without A4. This is the "before" reference for every comparison below.
> - `a4-probe/extension/test/regression/zz-a4-review.test.ts`: 15 probes, all passing on A4: REPROs reproduce, SOUNDs hold (Appendix B).
> - `a4-probe/extension/test/regression/zz-a4-logmatrix.test.ts`: where the security-log entry is lost, by crash point.
>   It also ran in `a4-base/` (Appendix C).
> - `a4-probe/extension/test/fault/zz-a4-lying.test.ts`: the crash-matrix extension, with a lying disk and a double
>   fault (Appendix D). Rows are in `a4r-lying.json`.
> - `a4-probe/extension/test/regression/zz-a4-purge.test.ts`: the A4R-12 probe.
> - `a4-e2emut/R09`, `a4-e2emut/R17`: UI mutants run against the e2e reset test.
> - `a4-base/extension/test/regression/zz-a4-base.test.ts`: the base-tree references for A4R-1 and A4R-3.
> - `a4r-mut.py`, `a4r-mut/<id>/result.json`, `a4r-mut-all.log`: the reviewer's 22 mutants (§Mutation testing).
> - `a4-c6/`: main + A4 + C6, used for item (6).
>
> Line numbers are those of the A4 tree (`a4-review/extension`).

## Verdict

**MERGE AFTER FIXES.** M2 may start once this is merged with the fixes below.

The store-layer work is sound and does what G-M2 asked:
- the marker is written for every keyring change, by `canonicalJson`;
- `staleIn` compares whole keyrings, which closes P-5;
- FIXa2 overwrites the keyring it rejects;
- there is one cleanup entry point, and unknown-key copies are offered to the callback first, with the keep/drop rule
  by vault id;
- `lock` is required;
- `startSession` failing after a commit no longer reports a failure;
- `onCode` delivers the code before the session, the cleanup and the log.

I re-ran the implementer's crash matrix and extended it: a lying disk that drops any single write, and a crash during
the self-check after a crash. All 438 extra rows hold every hard invariant:
- no account is ever lost;
- some credential the user holds always opens the vault;
- after `selfCheck`, the pointer slot, the keyring copy and the mirror agree;
- the marker promise holds at every double-fault point.

What is not sound is mostly in the page and service layers around it.

1. **A4R-1 (High): the popup reset now locks out a user on the most natural way of saving the code.**
   - The popup shows R2 before anything is written.
   - The user copies R2 and switches to the password manager to save it. That closes the popup, so nothing is
     committed.
   - A user who saves R2 over R1 holds R2 (dead), P2 (never set) and a forgotten P1. Nothing they hold opens the vault.
   - Before A4, the same steps left P2 working.
2. **A4R-2 (Medium): the security-log entry is written after the cleanup, so the new code is on screen before its entry
   exists.**
   - Closing the page while the cleanup runs loses the entry for good.
   - Crash points where the code was seen but has no entry: 0 before A4; 9 to 19 per operation with A4.
3. **A4R-3 (Medium): the GM2-7 rule turns "IndexedDB always fails" into "the vault never opens" whenever the decrypt
   fallback is needed.**
   - This happens even when the newest local copy, a copy of the very same save, opens.
   - Before A4, the fallback restored it.

None of the three needs a store change. A4R-1 is a page change: move the reset to a tab, or, as an interim, go back to
the one-call reset with `onCode` plus a confirmation field for P2. A4R-2 moves one line. A4R-3 is a small change to the fallback rule.

| Severity | Count | Findings |
|---|---|---|
| Critical | 0 | — |
| High | 1 | A4R-1 |
| Medium | 2 | A4R-2, A4R-3 |
| Low | 7 | A4R-4, A4R-5, A4R-6, A4R-7, A4R-8, A4R-12, A4R-13 |
| Info | 3 | A4R-9, A4R-10, A4R-11 |

**Blocks merge**: A4R-1. A4R-2 is a one-line move and is recommended in the same follow-up.
**Blocks M2**: none, provided that A4R-4's one-sentence contract ("a record's read-check-write is one
`sixkey-vault` critical section") goes into the VkRecord doc or §0.0i requirement 5 before M2 implements the records.
A4R-11 and A4R-12 are M2 notes.

## Verification (scratch copy `a4-review/`)

| Claim | Confirmed |
|---|---|
| typecheck clean | yes (`npm run typecheck`, exit 0) |
| 1050 unit tests | yes: 59 files, **1050 passed, 1 skipped** (77 s) |
| 72 e2e | yes: **72 passed** (4.7 min; `npm run build:e2e && npx playwright test`) |
| popup 56.3 KB gz | yes: `check-dist` prints "popup gzip: 56.3 KB (budget 60 KB) = static 47.4 KB + largest catalog zh_CN 8.9 KB", check-dist OK |
| read gates unchanged: open 4, unlock 7, degraded 10 | yes (`read-budget.test.ts` table): open 4 / 1.02x / 2 / 0 at 10, 100 and 500 accounts with 2 or 17 snapshots; lock screen + unlock 7; IndexedDB failing after a key change: unlock 10 / 3.02x / 2 / 1; device-key vault: open 3 |
| 39 mutants killed | per the implementer's logs (`phase0x/A4/mut-all2.log`), not re-run. I1 (lock optional again) is killed only by `tsc` through the `@ts-expect-error` line, which is the intended enforcement. My own 22 mutants are in §Mutation testing |
| crash matrix | the package's `test/fault/gm2-crash-matrix.test.ts` passes (9 operations). My extension, 438 rows, also passes (Appendix D) |

## Findings

### A4R-1 (High): the popup reset shows the code before committing, in a window that closes when the user goes to save it

**Where**
- `src/popup/screens/Locked.tsx:42`: "Continue" calls `prepareReset`.
- `Locked.tsx:63-95`: only "I saved it" (`confirmReset`) calls `commitReset`.
- `service.ts:717-771`: `prepareReset` and `commitReset`.

**Failing sequence** (probe A4R-1, `zz-a4-review.test.ts`; the reference is `zz-a4-base.test.ts` on the base tree)
1. The user has forgotten P1, which is why they are resetting. They open the popup: Use recovery code, then Set a new
   password. They enter R1 and P2, then press Continue.
2. R2 is shown with "I saved it". Nothing is written.
3. The user copies R2 and switches to the password manager to save it. That can be a desktop app or another
   extension's popup. Any focus change closes the Sixkey popup, the handle goes with it, and nothing is committed.
4. In the password manager, the user replaces R1 with R2 in the existing entry, which is the usual way to keep one
   current code.
5. The user reopens the popup. P2 gives "wrong password" and R2 gives "wrong recovery code", and both are recorded as
   guesses in the security log (probe). R1 is overwritten and P1 is forgotten.
6. **Nothing the user holds opens the vault.**

**Before A4**, the same steps had committed at step 1. P2 opened the vault, and R2 was live if it had been copied, so
the save in step 4 even worked (reference probe). GM2-13 (Low) only covered the user who left the popup without copying
R2: R1 dead, P2 working.

**What A4 changed.** It traded "R2 may be lost, P2 works" for "P2 never set, R2 dead":
- The flow succeeds only if the user presses "I saved it" before actually saving the code (copy, then confirm, then
  switch), or writes it down without leaving the popup.
- The note (`resetCodeNote`) says so, but leaving the popup is how people save a code. That is the same reason A1
  moved first-run to a tab.
- The e2e test (`flows.spec.ts:305`) demonstrates exactly this: it closes the popup, reopens it, redoes the reset with
  R1 and confirms. It assumes R1 is still at hand.
- PHASE0X-PLAN A1 (`PHASE0X-PLAN.md:371-376`, "why a tab, not the popup") names both horns:
  - nothing written when the popup closes, leaving the user a recovery code that matches no vault;
  - or written first, with a code the user may never see.

  Both lead to data loss later. A4 chose the first. For a reset it is the worse one, because the user has already lost
  the old password.

**Where A4's flow is the safer one.** The popup's reset form has a single new-password field (`#next`,
`Locked.tsx:110-115`) with no confirmation.
- Under commit-then-show, a mistyped P2 plus a popup that closes before R2 is copied leaves nothing that opens: R1 is
  already dead.
- A4's flow survives that typo, because R2 is committed only after "I saved it".

So neither horn is safe in a popup, which is `PHASE0X-PLAN.md:371-376`'s point.

**Fix** (before merge)
- (b) **Primary: the reset in a tab**, the GM2-1(d) / GM2-13 option. "Forgot password" opens the options page at
  `#reset`, and the two-step `prepareReset` / `commitReset` flow runs there.
  - A tab survives focus loss, so "I saved it" can come after the save.
  - Add a confirmation field for the new password.
  - This is the A1 pattern and the right end state. The service side is already done.
- (a) **Acceptable interim, only together with a confirmation field for P2**: the popup goes back to the one-call
  reset with GM2-1's fixes, `rt.service.resetPasswordWithRecovery(value, next, { onCode: setNewCode })`, showing the
  code that `onCode` delivers.
  - P2, typed twice, works the moment the commit lands.
  - A popup that closes later loses at most R2, while P2 works. That is GM2-13's original Low, and the user can make a
    new code in Settings.
  - Without the confirmation field, (a) trades A4R-1 for the typo lockout above.

Either way, flip `source-rules.test.ts` "GM2-13" and `flows.spec.ts:305` to the chosen flow.

**Blocks merge**: yes. **Blocks M2**: no.

### A4R-2 (Medium): the security-log entry is written after the cleanup, so the code is on screen before the entry exists

**Where**: `service.ts:670-688` (`committed()`): `onCode` (:671-677), then `startSession`, then `scrubQuietly` (the
whole cleanup), then `record(kind)` (:687).

**Failing sequence** (probe A4R-2; the matrix is in Appendix C)
1. Someone at an unlocked browser presses "New recovery code". Today that needs no password: C6-1 is still open.
2. R2 appears through `onCode`. The person reads or photographs it and closes the tab while the cleanup runs.
3. The owner's R1 is dead and R2 is live, and there is no `recovery_code_new` entry. No later open or unlock adds one:
   the marker finishes the cleanup, not the log (probe).

Closing too early is free. Before the commit nothing changes and nothing is recorded. So the person can start early
and close a little later on each try until the code flashes.

**Before A4**, every code-making operation recorded the entry before it returned the code. A3-13 notes this order: the
code waits for the log write. So seeing the code implied the entry existed.

Crash points (process death at write N, before or after it lands):

| Operation | Seen, no entry: base | Seen, no entry: A4 | Committed, no entry: base | Committed, no entry: A4 |
|---|---|---|---|---|
| newRecoveryCode | 0 | **9** | 6 | 14 |
| rotateKey | 0 | **19** | 26 | 26 |
| enableMasterPassword | 0 | **19** | 26 | 26 |
| resetPasswordWithRecovery (one call) | 0 | **11** | 8 | 16 |
| changePassword (no code) | — | — | 8 | 16 |

For the same-key operations, the window grew by the whole cleanup.

**Fix**: in `committed()`, call `record(kind)` right after `onCode`, before `startSession` and the cleanup.
- The log has its own key and lock, and the record never throws.
- A3-5 already says the "log write is the last write" rule in `security-log-crash.test.ts` is "a property the test
  imposes, not one the protocol needs". Relax it to "alone, and after the commit".
- Mutant R11 is this exact change. It shows which tests pin the current order (§Mutation testing).
- Recording before `onCode` would close the window entirely, at the cost of one more write in GM2-1's never-shown
  window. Either order is fine. Recording after the cleanup is not.

**Blocks merge**: no (recommended in the same follow-up; it is one moved line). **Blocks M2**: no.

### A4R-3 (Medium): GM2-7's rule plus an IndexedDB that always fails: the decrypt fallback never succeeds

**Where**
- `store.ts:771-790` (`openVault`):
  - `skipped(e, seq = Infinity)`;
  - `readMirrorGen(skipped)` (:779);
  - the mirror's index read failure goes through `snapshotCandidates` with no seq (:344);
  - `if (u && u.seq > c.seq) throw u.error` (:790).

**Failing sequence** (probe A4R-3; the base-tree reference is in `zz-a4-base.test.ts`)
1. A profile whose IndexedDB throws on every call. This is GM2-6's "Internal error opening backing store", a real
   group of users, and it can persist.
2. The active slot passes its checksum but does not open. That is the decrypt-fallback case.
3. The newest local copy, the rolling snapshot of that very save (the same save counter as the active slot), is
   intact.
4. `openVault` marks the mirror generation and the mirror index as unread with seq `Infinity`. So
   `Infinity > c.seq`, and it throws the IndexedDB error on every open and every unlock, forever (probe: 3 retries).
5. No credential opens the vault until IndexedDB recovers, which for this error may be never.

**Before A4**, the fallback restored that snapshot with all accounts and a `decrypt_fallback` notice (reference probe).

**Why the rule is too strict here**
- The mirror generation is written after the local commit, with the same save counter. It is ahead of every local copy
  only after GM2-8's local tail loss, which is deferred and which `selfCheck` overwrites anyway.
- An unreadable mirror therefore cannot hide a newer save than a local copy whose counter equals the active slot's.
- The `>` comparison itself is right: an equal counter means the same save. An unread copy with the counter of the
  copy that opens loses nothing (mutant R07 shows `>=` is untested).

**Fix**
- When the unread source is the mirror (generation or index) and nothing says how new it is, use the active slot's
  counter instead of `Infinity`. A local copy of the same save can then be restored.
- Keep `Infinity` for a local index read that throws.
- For the remaining case, where only an older copy opens and a mirror read keeps throwing, the error screen should
  eventually offer "open the newest copy that can be read", with the user's consent and an event. Otherwise "Retry"
  never ends.
- §0.0i requirement 8 needs the same carve-out before M2 extends this loop with the previous-VK fallback.

**Blocks merge**: no. **Blocks M2**: no (M2 must carry the carve-out into requirement 8).

### A4R-4 (Low, M2 trap): `VkRecord.reencrypt` runs outside the vault lock; a read-modify-write split across it leaves a record under a superseded key with no marker

**Where**
- `service.ts:73-87`: the `VkRecord` contract says "makes its own read and write safe against other writers of its key
  (M2: under the same webLock)".
- `service.ts:451-461`: `finishKeyChanges` calls each record before `store.finishKeyChange`, outside the lock.

**Failing sequence** (probe A4R-4: a record that reads, re-encrypts, and only then writes)
1. Page A rotates VK1 to VK2. Its cleanup reads `sk_prejoin` (under VK1) and re-encrypts it to VK2.
2. Before A's write, page B, unlocked with VK2, rotates to VK3. B's cleanup moves the record from VK1 to VK3 and
   removes the marker.
3. A's write lands: `sk_prejoin` is now under VK2.
4. The active key is VK3, and there is no marker. `staleIn` never looks at records (the GM2-4 decision), so nothing
   moves it on. It stays readable through `previous`, but the marker's promise, "nothing under an old key without a
   pending cleanup", no longer covers it.

If the record's read, check and write are one critical section under `webLock("sixkey-vault")`, the sequence cannot
happen. A's step either runs before B's transact, or finds VK3 and reports "unopenable". The contract's wording does
not say "one section", and the natural implementation (`get`, re-encrypt, `set`) is split.

**Second trap**: `webLock` is not re-entrant. If M2 calls the cleanup from inside the store lock (§3.13's `afterCommit`
runs inside it) and a record takes the lock, it deadlocks.

**Fix (contract text now, code in M2)**
- "`reencrypt` does its read, the check that the active keyring's vkId is still `current`, and its write in one
  `webLock("sixkey-vault")` critical section, and is never called from inside one."
- Alternatively, run the records inside `store.finishKeyChange`'s locked step, after its vkId check, by passing them
  in.
- Add the interleaving above as an M2 test.

**Blocks merge**: no. **Blocks M2**: no, provided the sentence is in the VkRecord doc / §0.0i requirement 5 before M2
writes `sk_sync_cfg.enc` or `sk_prejoin`.

### A4R-5 (Low): the onCode contract is enforced by name and by grep only

**Where**
- `service.ts:96` (`onCode?`), `:591`, `:612`, `:779`, `:786` (`deliver: CodeDelivery = {}`);
- `test/unit/source-rules.test.ts:70-80`.

**Ways around it**
1. **`{ onCode: () => undefined }`** passes the rule (it only checks that the word appears). With the code then shown
   from the return value after the cleanup, GM2-1(b) is undone and every test passes: mutant **R01 survived** the
   package's tests and the reviewer's probes.
2. **Only `popup/` and `options/` are scanned, and only `rotateKey`, `enableMasterPassword` and `newRecoveryCode`.**
   - `resetPasswordWithRecovery` is public, has no production caller, and is checked only for absence from `popup/`.
   - An options or `ui/` caller without `onCode`, or a call through `.call(`, bracket access or destructuring, is not
     seen.
   - The `calls.length === 3` tripwire helps for new direct calls in those two folders only.
3. **A throwing `onCode` is swallowed** (`service.ts:672-676`). `Security.tsx` ignores the return value, so the page then
   shows no code for a committed change. Harmless with `setCode`, which does not throw, but the contract invites it.
4. **The `finishKeyChange` rule** (`source-rules.test.ts` §0.0i req. 5) matches `\.finishKeyChange\s*\(`. That misses
   `.finishKeyChange.call(`, `store["finishKeyChange"]` and `const { finishKeyChange } = store`. Only deliberate code
   does that.

**Fix**
- Make the delivery required by type: `deliver: { onCode: (code: string) => void }` with no default, on all four
  methods. Tests pass `{ onCode: () => undefined }` explicitly.
- Remove `resetPasswordWithRecovery` from the service, or rename it to a test-only helper, unless A4R-1(a) reuses it,
  in which case add it to the rule.
- Have pages also `setCode(r.recoveryCode)` after the call (idempotent), so a throwing `onCode` still shows the code.
- Extend the `finishKeyChange` rule to "the identifier `finishKeyChange` appears only at its definition and the one
  call".

**Blocks merge**: no. **Blocks M2**: no.

### A4R-6 (Low, for C6): C6 does not typecheck on top of A4; its device-key export path works

**Where**: C6's `test/unit/backup-subset.test.ts:329` (in `a4-c6/`): `new VaultStore({ kv, now: () => t.now })`.

**Failing sequence**
1. Apply `phase0x/C6/C6.patch` on main + A4. It applies cleanly, including `flows.spec.ts`.
2. `tsc` fails: `Property 'lock' is missing in type … but required in type 'StoreOptions'`. GM2-11 made `lock`
   required, so `npm run verify` is red.

**Fix**: in that file, `import { createMutex, MemoryKV }` and `lock: createMutex()`. With that line changed:
- typecheck is clean;
- `backup-subset.test.ts` gives 12 passed;
- `export.spec.ts` + `flows.spec.ts` give **19 passed** on A4 + C6.

**The device-key export path** (the question asked) works, on current main and on A4:
- `verifyPassword` checks `not_protected` (`service.ts:509`) before it derives anything (`:512`). So
  `verifyPassword("")` on a device-key vault rejects with `not_protected`.
- On a password vault it rejects with `empty_password` and records nothing (probe A4R-8).
- C6's `confirmed()` relies on exactly that, and C6's e2e "a vault without a master password (Phase 0) warns, then
  exports without asking for one" passes on A4 + C6.
- `verifyPassword` is byte-identical in base and A4. A3's `""` handling did not break it, because of the check order.

**Also coordinate**: C6-1's proposed `newRecoveryCode(password)` collides with A4's `newRecoveryCode(deliver)`.
- Use `newRecoveryCode(password, deliver)`.
- The source rule's regex still requires `onCode` in the arguments.

**Blocks merge (A4)**: no. **Blocks C6's merge after A4**: yes (one line).

### A4R-7 (Low): GM2-2(b) is still open, and a rollback is now silent and final

**Where**: `store.ts:209-218`. FIXa2 now writes a diagnostics line (`key change rolled back …`) and overwrites the
rejected slot (GM2-2(a), correct), but pushes no event.

**Sequence**
1. The user resets, presses "I saved it" (or sees R2 in Settings after a rotation) and discards R1.
2. A power loss drops the pointer write and everything after it, so the cleanup's writes are lost too. The lying-disk
   rows "drop#3 (sk_active)" are this case.
3. At the next start, FIXa2 rolls back. P1 and R1 open the vault; P2 and R2 do not.
4. Nothing on screen explains it.
5. After A4 the rejected keyring is gone from the other slot as well. Before A4 it lingered, which was GM2-2's bug but
   also the only trace of it.

The implementer's reason for not recording an event ("every event is shown as data restored automatically") is about
the copy, not the mechanism. It needs one `StorageEventKind` and two strings.

**Fix**: as GM2-2(b): add a `keychange_rolled_back` event and the popup line "a change to your password or recovery
code did not finish and was undone…".

**Blocks merge**: no. **Blocks M2**: no (before release).

### A4R-8 (Low): popup reset edge cases leave the code screen up when it should not be

**Where**: `Locked.tsx:63-95`.

1. **The session write fails after a successful `commitReset`.** The service half is the probe; the UI half is from
   reading `popup/App.tsx`, which renders the same `<Locked>` element for "locked" again, so its state is kept.
   - `committed()` logs it and resolves, and `onUnlocked()` reloads.
   - The screen is still "locked", so `<Locked>` stays mounted with `pending` set, and the R2 screen stays up.
   - Pressing "I saved it" again gives `bad_state "reset already used"` for a reset that worked. P2 works, and Back,
     then the password, unlocks.
2. **`commitReset` is refused with `bad_state "keys changed meanwhile"`.**
   - The code screen stays up with a button that can never succeed.
   - The R2 on screen will never work, and the generic "reload" line does not say so.
3. **A commit that landed and reported a failure, then a new code made in another page.**
   - The retry says `bad_state` although the reset is in force (probe). This needs a double fault plus a concurrent
     change, so it is noted only.

**Fix**
- After `commitReset` resolves, always clear `pending`. If the reload shows "locked", show "Password reset; unlock with
  your new password".
- On `bad_state`, clear `pending` and say "your keys changed in another window; start again".
- Mutant R17, which drops the code on any error, also survives. Nothing tests the error UI.

**Blocks merge**: no. **Blocks M2**: no.

### A4R-12 (Low, M2): `purgeForever` cannot erase a secret from another vault's copies kept for "find accounts"

**Where**
- The GM2-4 decision keeps another vault's snapshots, re-encrypted to the current key with their own vault id
  (`store.ts:722-733`).
- `purgeForever` (`service.ts:850-868`) purges by entry id.

**Failing sequence** (probe `zz-a4-purge.test.ts`)
1. The device joins another vault (§3.5). The callback, holding the old key, re-encrypts the old vault's snapshots.
2. "Find accounts" adds an account from them. Added mode gives it a new id.
3. The user purges it ("erased from every copy Sixkey keeps").
4. The old vault's copies still hold the secret, under the current key.

No Phase 0.x path makes such copies, so this is for M2.

**Fix (M2)**: in `purgeIn`, also remove entries whose secret matches a purged one from copies of another vault, or drop
another vault's copies on a purge. Then state the rule in SECURITY.md.

**Blocks merge**: no. **Blocks M2**: no (an M2 work item).

### A4R-13 (Low): rules no test pins (mutants that survive the package's tests)

**Where**: `store.ts:637-640` (`staleIn`'s keyring-copy check), `store.ts:771-790` (`openVault`'s unread rule),
`options/Security.tsx:84`, `popup/screens/Locked.tsx:63-76`.

From §Mutation testing:
- **R14**: `staleIn` compares the keyring copy by vkId again.
  - The other slot is still compared by whole keyring, so every package test passes.
  - The bug: a same-key change whose cleanup fails at the keyring-copy write. Its next cleanup then removes the
    marker with the old password's wrap still in `sk_keyring` (P-5 again, after a double fault).
  - The reviewer's probe A4R-13 (Appendix B) kills it. Add it to `gm2-fixes.test.ts`.
- **R07** (`>=` in the fallback comparison) and **R08** (the first unread counter kept instead of the highest).
  - Add the two probes "kills R07" and "kills R08" (Appendix B; each one fails on its mutant and passes on A4):
    - a daily and a rolling snapshot of the same save; the daily's read throws, and the rolling one is restored;
    - an older copy's read throws first and the mirror generation's after, with only a copy between them that opens:
      the open must fail.
- **R01**: the Security page passes a no-op `onCode`. This is A4R-5's type-level fix. No e2e test exercises the
  rotation or new-code UI at all.
- **R17**: the popup drops the code on any commit error. This is A4R-8's UI. Nothing tests the reset's error states.

**Blocks merge**: no. **Blocks M2**: no.

### A4R-9 (Info): `touch()` can clear a fresh unlock

**Where**: `service.ts:267-274`.

**Sequence**: between `touch()`'s check and its write, a lock and a new unlock both land, for example the service
worker's screen lock followed by an unlock in the settings page. `touch()` then:
1. writes the stale session over the new one;
2. sees the epoch moved;
3. clears it (probe A4R-6).

This fails safe (the user unlocks again) and needs a PBKDF2 unlock to fit inside a few milliseconds. No change needed.
If wanted: re-read the session before clearing, and clear only if it is still the one `touch()` wrote.

**Blocks merge**: no. **Blocks M2**: no.

### A4R-10 (Info): under a lying disk, the marker promise breaks where a dropped write is not read back (pre-existing)

**Where**: `store.ts:726` (`rewriteInner` writes a re-encrypted snapshot and never reads it back), `store.ts:453-457`
(the over-lost marker) and `service.ts:353-375` (`makeVault` runs no cleanup).

From the lying-disk matrix (Appendix D):
- A dropped snapshot re-encryption in `rewriteInner` (`rotateKey` / `enableMasterPassword` drop #8 to #12). The
  cleanup believes it rewrote the record, removes the marker, and the record stays under the old key.
- A dropped over-lost marker (`startOver` drop #1). `makeVault` runs no cleanup itself, so if the marker is gone,
  nothing ever drops the lost vault's snapshots (A2-4).

Both are unchanged by A4, and a real disk either lands a write or throws. Optional fixes:
- read snapshot rewrites back as slot writes are;
- run the cleanup after `makeVault` over lost data, as the key-change methods do.

**Blocks merge**: no. **Blocks M2**: no.

### A4R-11 (Info): keyring byte-stability is not among §0.0i's eleven M2 requirements

**Where**: `SYNC-DESIGN.md:276-290` (§0.0i, the eleven M2 storage requirements) and `store.ts:453` (the marker by
`canonicalJson`).

GM2 hand-off item 10 ("sync state stays out of the keyring, which must be byte-stable across ordinary saves") did not
make it into revision 9's list.

With A4, every keyring difference writes a marker and costs a full cleanup at the next open. That means reading every
slot, the keyring copy, the mirror generation and every snapshot in both stores, then rewriting the other slot, the
keyring copy, the mirror generation and the snapshot index. FIXa2 and FIXb also key on it.

Is a per-save keyring field realistic? Not as specified:
- §3.13 says `Keyring v1` is unchanged;
- `kver`, `adopted` and the pins live in the bundle or in IndexedDB;
- `canonicalJson` sorts keys and drops `undefined`, so a keyring adopted in another key order is not a change.

The one planned rewrite is §2.3's one-time `createdAt` truncation before the first upload: one marker and one cleanup,
which is correct.

**Fix**: add the sentence as requirement 12, plus a unit test that an ordinary `mutate` keeps
`canonicalJson(keyring)`. `keychange-marker.test.ts` already checks that an ordinary save writes no marker.

**Blocks merge**: no. **Blocks M2**: no (a requirement sentence for M2).

## (1) Never-lose-access: the crash matrix, re-run and extended

**The implementer's matrix** (`test/fault/gm2-crash-matrix.test.ts`, 9 operations, process death at every write,
before or after it lands, with and without a restart) passes in my copy. Its added hard invariant, "a code the page was
shown opens what is committed", holds at every point. Its summary bounds GM2-1(b)'s never-shown window to the commit's
own writes (at most 8 distinct points), and the popup reset has none. I read the matrix:
- it models a page that has died as running no page code (`shown.alive()`);
- it treats a confirmed-before code (prepareKeys, prepareReset) as held;
- it asserts the marker promise by whole keyring.

It is a faithful extension of GM2's Appendix C.

**My extension** (`zz-a4-lying.test.ts`, 438 rows, 55 s). The same 9 operations, two new fault models:
- **Lying disk**: exactly one local write (index 1 … N, `set` or `remove`) reports success and is not applied, while
  every other write lands. The run completes, so the code is shown. Then a restart, or no restart.
  - This produces every two-slot / pointer / keyring-copy / mirror / snapshot divergence one write can make.
- **Double fault**: the process dies at write N, before or after it lands. At the restart, `selfCheck` itself dies at
  its write M, before or after it lands. Then a clean restart.
- **Hard at every row**: no account lost (the names before or after the operation); some credential the user holds
  opens; the triple is consistent after `selfCheck`. The marker promise is hard for the double-fault rows.
- **Result: all hold.**
  - Under a lying disk, a shown code is dead only when the commit's pointer write is dropped: FIXa2's accepted cost
    (A4R-7).
    - `rotateKey`, `newRecoveryCode`, `enableMasterPassword`: 2 rows each.
    - The one-call reset: 2.
    - The popup reset: 4, where the slot write is dropped (read back, refused, the error shown) or the pointer.
  - The marker promise breaks only under a lying disk, at A4R-10's two places.

**Answers**
- **Can a credential the user holds or was shown fail to open the vault?**
  - Under process death and I/O errors, the only new case is A4R-1: a code shown but not yet confirmed, by design and
    by a note the user is unlikely to act on.
  - Under a lying disk or power loss, a shown code dies when the commit's pointer write is lost. That is FIXa2's
    accepted cost, now silent and final (A4R-7).
  - With IndexedDB broken and the decrypt fallback needed, nothing opens (A4R-3).
- **Can a recovery code be shown that does not open the committed state?** Only in those same cases: a lying disk, or
  the popup's unconfirmed code.
  - `onCode` is called only after `transact` resolved (`service.ts:671`).
  - The cleanup after it rewrites to the generation read inside the lock, so it cannot undo the commit. Under a lying
    disk that dropped the pointer write it rewrites to the old one, and the shown code dies even before a restart.
- **The onCode contract.** Its enforcement is weak (A4R-5).
  - M2's adoption callers make no code, so they do not need it.
  - The §3.7 / §3.8 P2 sync flows must be prepare-and-commit, like A1 and the popup reset.
  - A page that closes during `onCode` (it is synchronous) or right after it has shown the code. The marker finishes
    the cleanup, but the log entry is lost (A4R-2).
  - An `onCode` that throws is logged, and the change completes. The page then shows nothing unless it falls back to
    the return value (A4R-5.3).

## (2) prepareReset / commitReset

**Sound** (probes A4R-5 "SOUND" and the implementer's `gm2-fixes.test.ts` GM2-13 block):
- **Concurrency**: `prepareReset` loads the keyring under the lock and derives keys outside it. `commitReset` re-checks
  `canonicalJson(current keyring) === base` inside the transact, so:
  - two popups from the same keyring: the second commit is refused and writes nothing;
  - a password change or a new code in another page between the steps: refused;
  - an ordinary save in between is kept, because the commit writes the current envelope.
- **A landed write treated as done**: `now === canonicalJson(prepared keyring)`. The prepared keyring carries fresh
  salts and IVs, so no other state can equal it.
  - Mutant R02 (vkId only, which would treat another page's same-key change as done) is killed.
  - Mutant R16 (base compared by vkId) is killed.
- **The handle**: spent after the commit, LANDED included, and before anything else.
  - A failed write keeps it for a retry (R04 killed).
  - `prepareReset` writes nothing of the vault (R05 killed).
  - A spent handle gives `bad_state "reset already used"`.
- **Commit after a lock** (screen lock or auto-lock between the steps): `commitReset` needs no session. It writes,
  then starts one at the current epoch, so the vault is unlocked by the user's own "I saved it". In "lock every time"
  mode the key stays in the popup's memory, as at any unlock.
- **Recording**:
  - the accepted code is recorded at prepare (A3-9);
  - a wrong code is recorded;
  - a malformed code and a weak password are not (R06 killed);
  - `password_reset` is recorded after the cleanup (A4R-2).
- **Popup closes between the steps**: R1 and P1 still work and R2 opens nothing. Verified at service level and by
  `flows.spec.ts:305`.

**Not sound**: the lifecycle itself (A4R-1) and the error states (A4R-8).

**Can neither the old nor the new password work?**
- After "I saved it" and a commit whose cleanup has not finished, a power loss that drops the pointer write rolls back
  to P1. The user forgot P1 and may have discarded R1 (A4R-7).
- Once the cleanup has finished, both slots carry the new keyring and FIXa2 cannot fire. That window is now the
  cleanup's few writes instead of "until the next save", which is strictly better than before A4.

## (3) The marker and the cleanup

- **Marker on any keyring change** (`store.ts:453`), **`staleIn` by whole keyring** (`:627`): correct.
  - P-5 is closed: after `changePassword`, `newRecoveryCode` and a reset, no slot, keyring copy or mirror generation
    opens with the superseded secret (`gm2-fixes.test.ts`, plus every completed row of my matrix).
  - The same-key adoption hook now works without `keyChange: true`.
  - Mutants R13 (by wrap count) and R14 (keyring copy by vkId) are killed (see the table).
- **Cost per save**: none for ordinary saves, whose keyring is byte-identical. A per-save keyring field is not
  planned (A4R-11).
- **Held keys and records outside the lock**: the held keys are only used to build the callback and to call the
  records. The store re-reads the generation inside its lock and refuses if the vkId moved. The records are the gap
  (A4R-4).
- **Keep and drop by vault** (`store.ts:645-650`, `:722-733`): matches §0.0i's decision.
  - Same vault, unopenable: kept and reported.
  - Another vault: offered to the callback first, kept re-encrypted if it opens, dropped if not.
  - `staleIn` counts another vault's unknown-key copies as stale in both stores, so the cleanup runs for them.
  - Purge drops every unknown-key copy.
- **Paths that drop data the user could still want**, checked:
  - **`startOver`**: the old vault's snapshots are under a key nobody has, and the user typed DELETE.
  - **`restoreBackup` of another vault over lost data**: the same; their keyring is gone in Phase 0. With sync,
    requirement 11 (cloud restore first) covers it.
  - **Join**: the held old key re-encrypts them; dropped only after a crash between ⑤ and ⑥, when the key is gone,
    per the decision.
  - The new exposure is the reverse one: copies kept and readable that a purge cannot reach (A4R-12).
- **One entry point**: `housekeeping`, `scrub` and M2's future callers go through `finishKeyChanges`. The grep rule
  can be bypassed only deliberately (A4R-5.4).
- **The security log after the cleanup**: a death during the cleanup loses the entry (A4R-2).
- **`touch()`**: GM2-10 is fixed. The pre-check refuses to write a voided session, and the post-check clears one a lock
  raced. `enforceAutoLock` clears voided sessions. The one side effect is A4R-9.

## (4) GM2-7, and the GM2-8 / GM2-9 deferrals

- **`>` on save counters**: correct. An equal counter is the same save. I checked the one case where the bytes differ:
  a damaged active slot and its intact rolling snapshot share a counter, and the snapshot is the good copy, which `>`
  correctly lets win. `>=` (R07) and "first unread, not max" (R08) both survive, so both rules are untested (see
  §Mutation testing). The rule's real problem is A4R-3.
- **GM2-8** (selfCheck overwrites a mirror generation newer than both slots). Deferring it to M2, whose server copy is
  the better source, is sound for M2. Non-sync users never get a server copy, though. It stays a Low data-rollback
  path (the last save before a power loss) and belongs on the before-release list. A4 does not change it.
- **GM2-9** (purge interrupted after its edit). Deferring it is sound. Every crash point is consistent, and only
  "erased from every copy" is weakened. Either the purge marker or a SECURITY.md sentence is enough before release.
- **Still open from GM2 and not in A4**: GM2-2(b) (A4R-7), GM2-6 (P-9; A4R-3 compounds it), GM2-14, GM2-15 (M2's
  `capPrevious`), GM2-16.

## (5) Tests

**Mechanical diffs.** For the 16 existing test files the patch touches (besides `flows.spec.ts`), I stripped
`lock: createMutex(), ` and the `createMutex, ` import and diffed against base.
- **13 are byte-identical** after that: `open-view-diff`, `security-log-crash`, `fault/store`, `clock`, `create-crash`,
  `enable-crash`, `merge`, `purge`, `session`, `store-misc`, `write-read-mismatch`, `import-backup`, `read-budget`.
- `createMutex()` is exactly the old default (`o.lock ?? createMutex()`), so their behaviour is unchanged.
- The other three are the intended changes, judged below.

**The changed tests**
- **`keychange-marker.test.ts`**:
  - "an edit does not write it; a new password or recovery code … does, before the commit, and its cleanup clears it":
    stronger. The old one passed only because the cleanup removed the marker; this one checks marker before commit,
    gone after, and `expectClean`.
  - "every keyring change writes it …": flips the old expectation as GM2-3 requires, and adds "the same keyring again:
    no marker". Stronger.
  - "restoreBackup of ANOTHER vault … / of the SAME vault …": split by the decision. Both halves are pinned (D3/D4 in
    the implementer's set), and records are removed, not just unlisted. Intent kept.
- **`a2-review.test.ts` "the cost"**: split into "cleanup finished, nothing rolled back" (new, stronger) and the
  original cost, now with a cleanup forced to fail.
  - It still kills X3 (FIXa2 by vkId) through a same-key reset.
  - It checks that the old wrap is still there, and that the marker is gone after the unlock.
  - Intent kept.
- **`service.test.ts`** "a key change that committed … session write … fails": it no longer expects a rejection, which
  GM2-1(a) requires. It still asserts the entry is recorded exactly once, and adds:
  - the returned code is live;
  - the cleanup ran;
  - the diagnostics line is there;
  - the rotation's old key is out of the session.
  - The enable case asserts no device material. Stronger.
- **`flows.spec.ts:305`**: the weak-password check is kept, and it adds the close-before-confirm path. It encodes
  A4R-1's flow and must change with its fix.
- **New**: `gm2-fixes.test.ts` (720 lines, every GM2 REPRO turned round, plus GM2-12's missing pins: lying disk X4/K6,
  FIXb same-key B3, C4 write order), `gm2-crash-matrix.test.ts`, `source-rules.test.ts`.

### Mutation testing (the reviewer's 22, beyond the implementer's 39)

Runner: `a4r-mut.py`. Each mutant is one exact replacement in a fresh copy of the A4 tree, then:
- `tsc`;
- **pkg**: the package's vitest suite, minus `sync-crypto-*` / `contract-*` and minus the reviewer's files;
- **review**: if pkg survives, `zz-a4-review.test.ts`.

The UI mutants were also run against the e2e reset test where noted.

| Id | Mutation | pkg | review | Killed by / note |
|---|---|---|---|---|
| R01 | Security page: `rotateKey(pw, { onCode: () => undefined })`, then `setCode(r.recoveryCode)` after the return | **survived** | **survived** | nothing. The grep rule only looks for the word `onCode`; no e2e covers the rotation UI (A4R-5, A4R-13) |
| R02 | LANDED when `vkId` matches and the keyring is not the base (another page's same-key change treated as "this reset landed") | killed | — | gm2-fixes "refused, writing nothing, if the keys changed in another page" |
| R03 | `makeVault` swallows a `startSession` failure | killed | — | create-crash "storing the session fails after the commit" (4) |
| R04 | reset handle spent before the write | killed | — | gm2-fixes "a commit that landed … retry with the same handle" |
| R05 | `prepareReset` commits the new keyring itself | killed | — | gm2-fixes "prepareReset writes nothing of the vault" and 3 more |
| R06 | `recovery_used` recorded before the code is checked | killed | — | gm2-fixes "a wrong code is recorded and refused …" |
| R07 | fallback: `u.seq >= c.seq` | **survived** | killed by the added probe | Appendix B "kills R07" (a daily copy of the same save unreadable) |
| R08 | fallback: the first unread counter kept, not the highest | **survived** | killed by the added probe | Appendix B "kills R08" |
| R09 | popup: `void commitReset(…)`, then `onUnlocked()` | **survived** | **survived** | also passes `flows.spec.ts:305`: the store lock orders the reload after the commit, so only the error path breaks, and nothing tests it (A4R-8) |
| R10 | one-call reset drops `deliver` | killed | — | gm2-fixes GM2-1(b) reset; matrix summary |
| R11 | `record(kind)` right after `onCode` (the reviewer's fix for A4R-2) | killed | — | gm2-fixes GM2-1(b) ×4 ("the log come after it") and security-log-crash "writes the log alone and last" (9 failures). These are the tests the A4R-2 fix must relax |
| R12 | `commitReset` starts no session | killed | — | gm2-fixes commitReset "… unlocked"; service.test (6) |
| R13 | marker by vkId, wrap count or device key (a same-count wrap replacement slips through) | killed | — | keychange-marker "an edit does not write it …", the crash matrix (10) |
| R14 | `staleIn`: keyring copy compared by vkId (other slot still by whole keyring) | **survived** | killed by the added probe | Appendix B "A4R-13 … keyring copy write" (a same-key change, cleanup fails at the copy) |
| R15 | `staleIn` vault rule inverted | killed | — | gm2-fixes GM2-4 (4) |
| R16 | `commitReset` compares the base by vkId | killed | — | gm2-fixes "refused … keys changed in another page" |
| R17 | popup drops the code on any commit error | **survived** | **survived** | also passes `flows.spec.ts:305`. Nothing tests the reset's error states (A4R-8) |
| R18 | `restoreRedundancy` heals the keyring copy only on a vkId difference | killed | — | crash matrix triple check, lying-disk probe (5) |
| R19 | `scrub` passes no held keys | survived | survived | **equivalent** in Phase 0: the rotation's old key is always in the new keyring's `previous`. The held-key path is covered by gm2-fixes' direct entry-point test (the implementer's E3) |
| R20 | an unreadable snapshot record counts as unknown age (`Infinity`) | killed | — | gm2-fixes "an older snapshot's read throws: the newest copy … is still restored" |
| R21 | session clear on failure inverted (the rotation's old key left in session storage) | killed | — | service.test "a key change that committed succeeds … session write … fails" |
| R22 | `newRecoveryCode` calls `onCode` inside the transact (before the guarded writes) | killed | — | gm2-fixes GM2-1(b) newRecoveryCode; matrix summary |

**Totals**: 22 mutants.
- The package's tests kill 14.
- Survivors: R01, R07, R08, R09, R14, R17, and R19 (equivalent).
- The reviewer's added probes (Appendix B) kill R07, R08 and R14.
- R01, R09 and R17 need A4R-5's type-level `onCode` and tests of the popup reset's error UI.
- Several rules hang on exactly one test: R02/R16 (the same one), R04, R06, R20 and R21.

## (6) C6 on top of A4

See A4R-6:
- the patch applies, but one C6 test misses `lock` and fails typecheck;
- with that one line fixed, C6's `export.spec.ts` and `flows.spec.ts` pass on A4 (19 passed);
- the device-key export path works on main and on A4 (`not_protected` before the KDF);
- C6-1's `newRecoveryCode(password)` must become `newRecoveryCode(password, deliver)`.

## Checked and found sound

- **GM2-1(a)**: `startSession` failing after a commit is logged, not thrown, in the four key-changing methods that
  start a session. `newRecoveryCode` starts none (`session: false`). A rotation's old key is taken out of session
  storage. `makeVault` still rethrows, so A1's handle stays retryable (R03
  killed).
- **GM2-1(b)**: `onCode` runs right after the transact's own writes, before the session, the cleanup and the log. The
  never-shown window is at most the commit's 4 writes.
- **GM2-2(a)**: the rejected slot is overwritten in the same `selfCheck` step (`otherGen = null`). It never holds data
  the user saw saved: GM2 Q1(c)'s argument is unchanged, and my lying-disk rows lose no account.
- **GM2-3**: the marker and `staleIn` by whole keyring. The same-key operations run the cleanup after the code is
  delivered. P-5 is closed.
- **GM2-4**: the code matches §0.0i's decision:
  - unknown keys are offered to the callback first;
  - keep or drop by vault id;
  - `staleIn` treats another vault as stale;
  - `rewriteForKeyChange` is purge only;
  - another vault's copy is never a decrypt fallback (F3);
  - `recover()` already matches on vault id.
- **GM2-7**: the comparison and the per-record counters are right. The mirror's unknown counter is too strict (A4R-3).
- **GM2-10**: fixed (`touch()` pre-check and post-check, `enforceAutoLock` clears voided sessions).
- **GM2-11**: `lock` is required by type (`@ts-expect-error` pins it), and only `platform/runtime.ts` builds a store,
  with `webLock("sixkey-vault")`.
- **GM2-12**: X4, B3, C4 and K6 are pinned in `gm2-fixes.test.ts`. The crash matrix is in `test/fault/`.
- **The two-step reset's service logic** (§2 above).
- **Plan constraints**:
  - no change to permissions, CSP or network;
  - popup 56.3 KB of 60;
  - read gates 4 / 7 / 10;
  - i18n through a fragment (`a4.py`), with `resetAction` removed and `resetCodeNote` added.
- **`canonicalJson`** sorts keys and drops `undefined`, so key order never counts as a keyring change.

## Closing verdict

**MERGE AFTER FIXES.**

| Severity | Count | Findings |
|---|---|---|
| Critical | 0 | — |
| High | 1 | A4R-1 |
| Medium | 2 | A4R-2, A4R-3 |
| Low | 7 | A4R-4, A4R-5, A4R-6, A4R-7, A4R-8, A4R-12, A4R-13 |
| Info | 3 | A4R-9, A4R-10, A4R-11 |

**Before merge**
1. **A4R-1**: move the reset to a tab (two steps, plus a confirmation field for the new password). As an interim, the
   popup may go back to the one-call reset with `onCode`, but only with a confirmation field for P2.
2. **A4R-2** (recommended, one line): record right after `onCode`, and relax `security-log-crash`'s "last".

**Top 3**
1. **A4R-1 (High).** The popup's show-before-commit reset fails on the natural way to save the code. A user who saves
   R2 over R1 is locked out, where before A4 their new password worked.
2. **A4R-2 (Medium).** The new code is visible before its security-log entry exists. Closing the page during the
   cleanup erases the record of a new code, a rotation, an enable or a reset (0 such crash points before A4, 9 to 19
   now).
3. **A4R-3 (Medium).** With IndexedDB failing for good, a decrypt fallback can never succeed, even when a local copy of
   the same save opens. Before A4 it restored it.

**May M2 start after merging?** Yes. Every "Before M2 starts" item of GM2-REVIEW is done in code or spec:
- GM2-1(a)/(b), GM2-3, GM2-4, GM2-11 are in code;
- GM2-5 is in the §0.0i spec.

M2 must also carry:
- A4R-4's one-sentence contract for `VkRecord`;
- A4R-3's carve-out in requirement 8;
- A4R-11's byte-stability sentence;
- A4R-12's purge rule for joined vaults.

---

## Appendix A: the reviewer's 22 mutants (`a4r-mut.py`, the `M` table)

```py
M = {
  # GM2-1(b) at the page: onCode passed but does nothing; the code shown only from the return value (after the cleanup)
  "R01-page-noop-onCode": [(SE, 'void run(async () => { await rt.service.rotateKey(rotatePw, { onCode: setCode }); setRotatePw(""); })',
                              'void run(async () => { const r = await rt.service.rotateKey(rotatePw, { onCode: () => undefined }); setRotatePw(""); setCode(r.recoveryCode); })')],
  # a DIFFERENT same-key state treated as "this reset already landed"
  "R02-landed-by-vkid": [(SV, 'if (now === mine) throw LANDED;', 'if (cur.keyring.vkId === p.keyring.vkId && now !== p.base) throw LANDED;')],
  # makeVault swallows the session failure (the A1 handle is then spent with no session)
  "R03-makevault-session-swallowed": [(SV, "    await this.startSession(vk);\n    preparedKeys.delete(keys);", "    await this.startSession(vk).catch(() => undefined);\n    preparedKeys.delete(keys);")],
  # the reset handle spent before the write
  "R04-handle-spent-before-write": [(SV, "    const mine = canonicalJson(p.keyring);\n    try {", "    const mine = canonicalJson(p.keyring);\n    preparedResets.delete(prepared);\n    try {")],
  # prepareReset commits the new keyring already (the old one-call order)
  "R05-prepare-writes-vault": [(SV, "    const handle: PreparedReset = Object.freeze({ recoveryCode });\n    preparedResets.set(handle, { base: canonicalJson(r.gen.keyring), keyring, vk });",
                                 "    await this.store.transact(async (cur) => ({ envelope: cur!.envelope, keyring }));\n    const handle: PreparedReset = Object.freeze({ recoveryCode });\n    preparedResets.set(handle, { base: canonicalJson(keyring), keyring, vk });")],
  # the accepted-code record made before the code is checked
  "R06-accepted-before-unwrap": [(SV, "    let vk: Vk;\n    try {\n      vk = await unlockWithRecoveryCode(r.gen.keyring, code);", "    if (accepted) await accepted();\n    let vk: Vk;\n    try {\n      vk = await unlockWithRecoveryCode(r.gen.keyring, code);"),
                                   (SV, "    if (accepted) await accepted();\n    const { keyring, recoveryCode }", "    const { keyring, recoveryCode }")],
  # GM2-7 comparison >=
  "R07-fallback-ge": [(ST, "if (u && u.seq > c.seq) throw u.error;", "if (u && u.seq >= c.seq) throw u.error;")],
  # GM2-7: the first unread copy's counter kept, not the highest
  "R08-unread-first-not-max": [(ST, "unread = { error: unread?.error ?? e, seq: Math.max(unread?.seq ?? -Infinity, seq) };", "unread = { error: unread?.error ?? e, seq: unread?.seq ?? seq };")],
  # the popup unlocks before the commit has finished
  "R09-popup-onUnlocked-before-commit": [(LK, "      await rt.service.commitReset(pending);\n      await onUnlocked();", "      void rt.service.commitReset(pending);\n      await onUnlocked();")],
  # the one-call reset drops the page's onCode
  "R10-oneshot-drops-deliver": [(SV, "    await this.writeReset(prepared, { code: prepared.recoveryCode, deliver });", "    await this.writeReset(prepared);")],
  # the log entry right after onCode (the reviewer's proposed fix for A4R-2): which tests pin "last"?
  "R11-record-right-after-onCode": [(SV, "    if (o.session !== false) {\n      try {\n        await this.startSession(vk);", "    await this.record(kind);\n    if (o.session !== false) {\n      try {\n        await this.startSession(vk);"),
                                      (SV, "    await this.scrubQuietly(o.oldVk ?? vk, vk);\n    await this.record(kind);\n", "    await this.scrubQuietly(o.oldVk ?? vk, vk);\n")],
  # commitReset leaves the popup locked
  "R12-commit-no-session": [(SV, 'await this.committed("password_reset", p.vk, code ? { code: code.code, deliver: code.deliver } : {});', 'await this.committed("password_reset", p.vk, code ? { code: code.code, deliver: code.deliver, session: false } : { session: false });')],
  # marker only when the number of wraps or the key changes (a same-key wrap replacement slips through)
  "R13-marker-by-wrap-count": [(ST, '(prev ? canonicalJson(prev.keyring) !== canonicalJson(gen.keyring) : cur.status === "lost")', '(prev ? prev.keyring.vkId !== gen.keyring.vkId || prev.keyring.wraps.length !== gen.keyring.wraps.length || (prev.keyring.deviceKey !== undefined && gen.keyring.deviceKey === undefined) : cur.status === "lost")')],
  # staleIn: the keyring copy compared by key id only (the slot by whole keyring)
  "R14-stale-copy-by-vkid": [(ST, "        if (!ok || old(ok.keyring)) return stale;\n      }\n    }\n    const idx", "        if (!ok || ok.keyring.vkId !== gen.keyring.vkId) return stale;\n      }\n    }\n    const idx")],
  # staleIn: the vault-id rule inverted (this vault's unknown copies stale, another vault's not)
  "R15-stale-vault-rule-inverted": [(ST, "if (previous.has(rec.envelope.vkId) || rec.envelope.vaultId !== gen.keyring.vaultId) return stale;", "if (previous.has(rec.envelope.vkId) || rec.envelope.vaultId === gen.keyring.vaultId) return stale;")],
  # commitReset compares the base by key id, not by whole keyring
  "R16-commit-base-by-vkid": [(SV, 'if (now !== p.base) throw new ServiceError("bad_state", "keys changed meanwhile");', 'if (cur.keyring.vkId !== p.keyring.vkId) throw new ServiceError("bad_state", "keys changed meanwhile");')],
  # the popup drops the code on any commit failure (a landed-but-failed commit then leaves a live code nobody kept)
  "R17-popup-drops-code-on-error": [(LK, '      logError("popup reset failed", e);\n      setError(errorLine(e));', '      logError("popup reset failed", e);\n      setPending(null);\n      setError(errorLine(e));')],
  # GM2-2: the rejected slot overwritten, but the keyring copy no longer healed in that branch
  "R18-fixa2-no-copy-heal": [(ST, "      if (!copy || canonicalJson(copy.keyring) !== canonicalJson(gen.keyring)) {", "      if (!copy || copy.keyring.vkId !== gen.keyring.vkId) {")],
  # the cleanup after a same-key change gets the stale keyring's previous keys only (held dropped in scrub)
  "R19-scrub-without-held": [(SV, "    const done = await this.finishKeyChanges(newVk, r.gen.keyring, [oldVk]);", "    const done = await this.finishKeyChanges(newVk, r.gen.keyring);")],
  # GM2-7: a snapshot whose read throws counts as unknown age (Infinity), not its indexed counter
  "R20-skipped-seq-dropped": [(ST, "          skipped(e, meta.seq);", "          skipped(e);")],
  # the rotation's old key left in session storage after a failed session write; and clear on same-key ops instead
  "R21-session-clear-inverted": [(SV, "if (o.oldVk && o.oldVk.id !== vk.id) await this.session.clear().catch(() => undefined);", "if (!o.oldVk || o.oldVk.id === vk.id) await this.session.clear().catch(() => undefined);")],
  # onCode called before the transact has returned (inside the commit: the code shown before the redundancy writes)
  "R22-newcode-onCode-inside-transact": [(SV, "      const r = await setRecovery(cur.keyring, vk, this.ctx);\n      recoveryCode = r.recoveryCode;\n      return { envelope: cur.envelope, keyring: r.keyring };\n    });\n    // Already unlocked",
                                           "      const r = await setRecovery(cur.keyring, vk, this.ctx);\n      recoveryCode = r.recoveryCode;\n      deliver.onCode?.(recoveryCode);\n      return { envelope: cur.envelope, keyring: r.keyring };\n    });\n    // Already unlocked"),
                                          (SV, 'await this.committed("recovery_code_new", vk, { code: recoveryCode, deliver, session: false });', 'await this.committed("recovery_code_new", vk, { session: false });')],
}
```

## Appendix B: probes (`a4-probe/extension/test/regression/zz-a4-review.test.ts`, scratch only)

Run: `npx vitest run test/regression/zz-a4-review.test.ts`. 15 tests, all pass on the A4 tree: each REPRO reproduces, each SOUND holds.

```ts
// A4 review probes (scratch only). Each "REPRO" asserts the problem as it is on the A4 tree; each "SOUND" asserts a
// property that holds. Run: npx vitest run test/regression/zz-a4-review.test.ts
import { describe, expect, it } from "vitest";
import { fromB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type ServiceDeps, type VkRecord } from "../../src/core/service/service";
import { SecurityLog } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { RoutedSession } from "../../src/platform/session";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { createProtected, legacyDeviceVault, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6 as const, period: 30 });

function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const diag: string[] = [];
  const store = (k: KV = kv, m: KV = mirror) => new VaultStore({ kv: k, mirror: m, lock: createMutex(), now: () => t.now, onDiag: (s) => diag.push(s) });
  const svc = (k: KV = kv, m: KV = mirror, s: SessionCache = session, extra: Partial<ServiceDeps> = {}) =>
    new VaultService({ store: store(k, m), session: s, settings, now: () => t.now, onDiag: (x) => diag.push(x), ...extra });
  const add = async (s: VaultService, n: string) => { t.now += 60_000; await s.mutate((v, c) => addEntry(v, input(n), c).vault); };
  return { kv, mirror, session, t, settings, store, svc, add, diag };
}
type W = ReturnType<typeof world>;
const wrap = (inner: KV, o: Partial<KV>): KV => ({ get: (k) => inner.get(k), keys: () => inner.keys(), set: (i) => inner.set(i), remove: (k) => inner.remove(k), ...o });
const ptrOf = (w: W) => w.kv.data.get(KEYS.active) as "a" | "b";
const otherOf = (s: "a" | "b") => (s === "a" ? "b" : "a");
const active = async (w: W) => (await checkGeneration(w.kv.data.get(KEYS.slot[ptrOf(w)])))!;
const opensWithCode = (k: Keyring, code: string) => unlockWithRecoveryCode(k, code).then(() => true, () => false);
const opensWithPw = (k: Keyring, pw: string) => unlockWithPassword(k, pw).then(() => true, () => false);
const sessionVk = (w: W) => vkFromRaw(fromB64(w.session.data!.vk));

describe("A4R-1 popup reset: the code shown is not committed until 'I saved it'", () => {
  it("REPRO: the popup closes while the user saves R2 over R1 in a password manager; P1 forgotten: nothing the user holds opens", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc()); // P1 = STRONG, forgotten later
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    const p = await w.svc().prepareReset(r1, STRONG2); // R2 on screen
    // the popup loses focus and closes: the handle is gone; nothing was written
    const r2 = p.recoveryCode;
    const k = (await active(w)).keyring;
    // what the user holds afterwards: P2 (typed), R2 (saved over R1). R1 overwritten, P1 forgotten.
    expect(await opensWithPw(k, STRONG2)).toBe(false);
    expect(await opensWithCode(k, r2)).toBe(false);
    // only the credentials they no longer hold still work
    expect(await opensWithCode(k, r1)).toBe(true);
    expect(await opensWithPw(k, STRONG)).toBe(true);
    // the lock screen says "wrong" for both, and records both as guesses
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    const s = w.svc(w.kv, w.mirror, w.session, { security: log });
    await expect(s.unlockWithPassword(STRONG2)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(s.unlockWithRecoveryCode(r2)).rejects.toMatchObject({ code: "wrong_secret" });
    expect((await log.read()).entries.map((e) => e.kind)).toEqual(["recovery_failed", "unlock_failed"]);
  });
});

// ---- A4R-2: the security log entry after the cleanup --------------------------------------------------------------------
class Dead extends Error {}
/** A process that dies at the first write after `armed` becomes true (the page closed right after the code appeared). */
function killer() {
  const st = { armed: false, dead: false };
  const kv = (inner: KV): KV => ({
    get: async (k) => { if (st.dead) throw new Dead(); return inner.get(k); },
    keys: async () => { if (st.dead) throw new Dead(); return inner.keys(); },
    set: async (i) => { if (st.dead) throw new Dead(); if (st.armed) { st.dead = true; throw new Dead(); } return inner.set(i); },
    remove: async (k) => { if (st.dead) throw new Dead(); if (st.armed) { st.dead = true; throw new Dead(); } return inner.remove(k); },
  });
  const session = (inner: MemorySession): SessionCache => ({
    get: async () => { if (st.dead) throw new Dead(); return inner.get(); },
    set: async (d: SessionData) => { if (st.dead) throw new Dead(); if (st.armed) { st.dead = true; throw new Dead(); } return inner.set(d); },
    clear: async () => { if (st.dead) throw new Dead(); return inner.clear(); },
    lockEpoch: () => inner.lockEpoch(), bumpLockEpoch: () => inner.bumpLockEpoch(),
  });
  return { st, kv, session };
}

describe("A4R-2 security log: the code is on screen before the entry is written", () => {
  const ops: [string, string, (s: VaultService, d: { onCode: (c: string) => void }, r1: string) => Promise<unknown>][] = [
    ["newRecoveryCode", "recovery_code_new", (s, d) => s.newRecoveryCode(d)],
    ["rotateKey", "key_rotated", (s, d) => s.rotateKey(STRONG, d)],
  ];
  it.each(ops)("REPRO %s: the page closes the moment the code appears: the change is made, the code was seen, no entry ever", async (_n, kind, run) => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const k = killer();
    const log = new SecurityLog({ kv: k.kv(w.kv), now: () => w.t.now });
    const s = w.svc(k.kv(w.kv), k.kv(w.mirror), k.session(w.session), { security: log });
    let seen = "";
    await run(s, { onCode: (c) => { seen = c; k.st.armed = true; } }, r1).catch((e) => { if (!(e instanceof Dead)) throw e; });
    expect(seen).not.toBe("");
    expect(await opensWithCode((await active(w)).keyring, seen)).toBe(true); // committed, and the code works
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(false); // the owner's code is dead
    const entries = (await new SecurityLog({ kv: w.kv, now: () => w.t.now }).read()).entries.map((e) => e.kind);
    expect(entries).not.toContain(kind);
    // and nothing adds it later: the next unlock finishes the cleanup, not the log
    w.session.data = null;
    const s2 = w.svc(w.kv, w.mirror, w.session, { security: new SecurityLog({ kv: w.kv, now: () => w.t.now }) });
    await s2.unlockWithPassword(STRONG);
    expect((await new SecurityLog({ kv: w.kv, now: () => w.t.now }).read()).entries.map((e) => e.kind)).not.toContain(kind);
  });
});

// ---- A4R-3: GM2-7 with IndexedDB failing for good ---------------------------------------------------------------------------
describe("A4R-3 decrypt fallback with an IndexedDB that always fails", () => {
  it("REPRO: the active copy does not open, the newest local snapshot does, the mirror throws on every call: openView fails on every retry", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const vk = await sessionVk(w);
    const act = await active(w);
    // the active copy passes its checksum but does not parse
    w.kv.data.set(KEYS.slot[ptrOf(w)], { ...act, envelope: await encryptVault(utf8("not a vault"), vk, { vaultId: act.keyring.vaultId, rev: act.envelope.rev + 1 }) });
    const fail = async () => { throw new Error("Internal error opening backing store for indexedDB.open."); };
    const broken: KV = { get: fail, keys: fail, set: fail, remove: fail };
    for (let i = 0; i < 3; i++) await expect(w.svc(w.kv, broken).openView()).rejects.toThrow(/backing store/);
    // the newest local copy, the rolling snapshot of that very save (same save counter as the active slot), opens:
    const snap = w.kv.data.get(KEYS.snap(`r${act.seq}`)) as { envelope: EncryptedVault };
    expect((await decryptVault(snap.envelope, vk)).length).toBeGreaterThan(0);
    // with a working (empty) mirror the very same store falls back fine
    const v = await w.svc(w.kv, new MemoryKV()).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]); // nothing lost
  });
});

// ---- A4R-4: VkRecord.reencrypt outside the vault lock (M2 trap) -------------------------------------------------------------
class GatedRecord implements VkRecord {
  readonly name = "gated record";
  gate: Promise<void> | null = null;
  onReached: (() => void) | null = null;
  constructor(readonly kv: MemoryKV, readonly key: string) {}
  async reencrypt(current: Vk, held: readonly Vk[]): Promise<"absent" | "current" | "rewritten" | "unopenable"> {
    const env = this.kv.data.get(this.key) as EncryptedVault | undefined; // read
    if (!env) return "absent";
    if (env.vkId === current.id) return "current";
    const k = held.find((h) => h.id === env.vkId);
    if (!k) return "unopenable";
    const next = await encryptVault(await decryptVault(env, k), current, { vaultId: env.vaultId, rev: env.rev });
    if (this.gate) { this.onReached?.(); await this.gate; } // the other context runs here
    this.kv.data.set(this.key, next); // write
    return "rewritten";
  }
}
describe("A4R-4 VkRecord: a stale context's record write lands after a newer key change's", () => {
  it("REPRO: page A's cleanup after its rotation (VK1->VK2) writes the record after page B rotated again (VK2->VK3): the record is left under VK2, no marker", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk1 = await sessionVk(w);
    const recs = new MemoryKV();
    recs.data.set("sk_prejoin", await encryptVault(utf8("prejoin"), vk1, { vaultId: "prejoin-vault-01", rev: 0 }));
    const recA = new GatedRecord(recs, "sk_prejoin");
    let release!: () => void;
    recA.gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { recA.onReached = r; });
    // page A rotates; its cleanup stops inside the record's re-encryption, before its write
    const sessA = new MemorySession(); sessA.data = w.session.data; sessA.epoch = w.session.epoch;
    const a = w.svc(w.kv, w.mirror, sessA, { vkRecords: [recA] }).rotateKey(STRONG);
    await reached;
    // page B (same vault, unlocked with the new key VK2) rotates again; its record step moves the record (still VK1) to VK3
    const vk2 = await vkFromRaw(fromB64(sessA.data!.vk));
    const sessB = new MemorySession(); sessB.data = { ...sessA.data! };
    await w.svc(w.kv, w.mirror, sessB, { vkRecords: [new GatedRecord(recs, "sk_prejoin")] }).rotateKey(STRONG);
    const vk3 = await vkFromRaw(fromB64(sessB.data!.vk));
    expect((recs.data.get("sk_prejoin") as EncryptedVault).vkId).toBe(vk3.id);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // B's cleanup finished
    release();
    await a;
    // A's late write: the record is back under VK2 (a previous key), with nothing left to move it on
    expect((await active(w)).keyring.vkId).toBe(vk3.id);
    expect((recs.data.get("sk_prejoin") as EncryptedVault).vkId).toBe(vk2.id);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- A4R-5..7: reset edges and touch() ---------------------------------------------------------------------------------------
describe("A4R-5 reset edges", () => {
  it("INFO: commitReset with a session write that fails: the reset is made, the popup stays on the code screen, and 'I saved it' again says 'already used'", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.svc().lock();
    class FailingSet extends MemorySession { override async set(_d: SessionData) { throw new Error("session write failed"); } }
    const s = w.svc(w.kv, w.mirror, new FailingSet());
    const p = await s.prepareReset(r1, STRONG2);
    await s.commitReset(p); // resolves
    expect(await opensWithPw((await active(w)).keyring, STRONG2)).toBe(true);
    expect((await s.status()).state).toBe("locked"); // App's reload shows the lock screen: Locked keeps `pending`
    await expect(s.commitReset(p)).rejects.toMatchObject({ code: "bad_state", message: "reset already used" });
  });

  it("INFO: a commit that landed and reported a failure, then a new code made in another page: the retry says bad_state although the reset is in force", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.svc().lock();
    const s = w.svc();
    const p = await s.prepareReset(r1, STRONG2);
    let pointer = false;
    let backFails = false;
    const kv2 = wrap(w.kv, { set: async (i) => {
      if (backFails && (KEYS.slot.a in i || KEYS.slot.b in i)) { backFails = false; throw new Error("IO error"); }
      await w.kv.set(i);
      if (!pointer && KEYS.active in i) { pointer = true; backFails = true; throw new Error("IO error after the write"); }
    } });
    await expect(w.svc(kv2).commitReset(p)).rejects.toThrow();
    expect(await opensWithPw((await active(w)).keyring, STRONG2)).toBe(true); // in force
    // another page unlocks with P2 (it works) and makes a new code
    const other = w.svc(w.kv, w.mirror, new MemorySession());
    await other.unlockWithPassword(STRONG2);
    await other.newRecoveryCode();
    await expect(s.commitReset(p)).rejects.toMatchObject({ code: "bad_state" });
  });

  it("SOUND: two popups prepare from the same keyring; the second commit is refused and writes nothing; the first one's code works", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.svc().lock();
    const a = await w.svc().prepareReset(r1, STRONG2);
    const b = await w.svc().prepareReset(r1, STRONG);
    await w.svc().commitReset(a);
    const before = JSON.stringify([...w.kv.data]);
    await expect(w.svc().commitReset(b)).rejects.toMatchObject({ code: "bad_state" });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
    expect(await opensWithCode((await active(w)).keyring, a.recoveryCode)).toBe(true);
    expect(await opensWithCode((await active(w)).keyring, b.recoveryCode)).toBe(false);
  });

  it("SOUND: an ordinary save between prepare and commit is kept (the commit writes the current envelope, not the one prepare saw)", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const s = w.svc(w.kv, w.mirror, new MemorySession());
    const p = await s.prepareReset(r1, STRONG2);
    await w.add(w.svc(), "AWS"); // another page, still unlocked
    await s.commitReset(p);
    expect(aliveEntries((await s.read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]);
  });

  it("SOUND: a password change in another page between prepare and commit: refused; the other page's password still works", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    const s = w.svc(w.kv, w.mirror, new MemorySession());
    const p = await s.prepareReset(r1, STRONG2);
    await w.svc().changePassword(STRONG, "another-pass-phrase-77");
    await expect(s.commitReset(p)).rejects.toMatchObject({ code: "bad_state" });
    expect(await opensWithPw((await active(w)).keyring, "another-pass-phrase-77")).toBe(true);
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(true); // changePassword keeps the code
  });
});

describe("A4R-6 touch() and a fresh unlock", () => {
  it("INFO: a lock and a fresh unlock land between touch()'s check and its write: touch overwrites the new session with the stale one, then clears it", async () => {
    const kv = new MemoryKV();
    const shared = new MemorySession();
    shared.data = { vk: "OLD", lastActive: 1, epoch: 0 };
    let raced = false;
    const racing: SessionCache = {
      get: () => shared.get(), clear: () => shared.clear(), lockEpoch: () => shared.lockEpoch(), bumpLockEpoch: () => shared.bumpLockEpoch(),
      set: async (d) => { if (!raced) { raced = true; await shared.clear(); await shared.bumpLockEpoch(); shared.data = { vk: "FRESH", lastActive: 2, epoch: 1 }; } return shared.set(d); },
    };
    const popup = new VaultService({ store: new VaultStore({ kv, lock: createMutex() }), session: new RoutedSession(racing, new KvSettingsStore(kv)), settings: new KvSettingsStore(kv) });
    await popup.touch();
    expect(raced).toBe(true);
    expect(shared.data).toBeNull(); // the fresh unlock is gone (the safe direction: the user unlocks again)
  });
});

// ---- A4R-8: C6's device-key export path on the A4 tree --------------------------------------------------------------------
describe("A4R-8 verifyPassword('') (C6 relies on it)", () => {
  it("SOUND: a device-key vault answers not_protected; a password vault answers empty_password and records nothing", async () => {
    const w = world();
    await legacyDeviceVault(w.store());
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    await expect(w.svc(w.kv, w.mirror, w.session, { security: log }).verifyPassword("")).rejects.toMatchObject({ code: "not_protected" });
    const w2 = world();
    await createProtected(w2.svc());
    const log2 = new SecurityLog({ kv: w2.kv, now: () => w2.t.now });
    await expect(w2.svc(w2.kv, w2.mirror, w2.session, { security: log2 }).verifyPassword("")).rejects.toMatchObject({ code: "empty_password" });
    expect((await log2.read()).entries).toEqual([]);
  });
});

describe("A4R-13 test gaps (kill R14)", () => {
  it("SOUND: a same-key change whose cleanup fails at the keyring copy write: the next cleanup still replaces the copy's old wrap", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    let failCopy = 0; // the transact's own copy write is guarded; fail it and the cleanup's one
    const kv = wrap(w.kv, { set: async (i) => { if (KEYS.keyringCopy in i && failCopy < 2) { failCopy++; throw new Error("IO error"); } return w.kv.set(i); } });
    await w.svc(kv).changePassword(STRONG, STRONG2); // succeeds; the cleanup stops at the copy
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG2); // the next cleanup
    const copy = w.kv.data.get(KEYS.keyringCopy) as { keyring: Keyring };
    expect(await opensWithPw(copy.keyring, STRONG)).toBe(false); // the old password no longer opens anything
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

describe("A4R-13 test gaps (kill R07, R08)", () => {
  async function broken(daily: boolean) {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    if (daily) await w.store().ensureDailySnapshot(); // a daily copy of the very last save (same save counter as r<seq>)
    const vk = await sessionVk(w);
    const act = await active(w);
    w.kv.data.set(KEYS.slot[ptrOf(w)], { ...act, envelope: await encryptVault(utf8("not a vault"), vk, { vaultId: act.keyring.vaultId, rev: act.envelope.rev + 1 }) });
    return { w, act };
  }
  const failing = (inner: KV, keys: string[]) => wrap(inner, { get: async (k) => { if (k.length === 1 && keys.includes(k[0]!)) throw new Error("IO error: transient"); return inner.get(k); } });

  it("SOUND (kills R07): the daily copy of the last save cannot be read; the rolling copy of the same save opens and is restored", async () => {
    const { w } = await broken(true);
    const dailyKey = [...w.kv.data.keys()].find((k) => k.startsWith("sk_snap_d"))!;
    const v = await w.svc(failing(w.kv, [dailyKey])).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
  });

  it("SOUND (kills R08): an older copy's read throws first, the mirror generation's after; only a copy between them opens: the open fails", async () => {
    const { w, act } = await broken(false);
    // the rolling copy of the last save is gone, so the best local copy is the other slot (one save older)
    w.kv.data.delete(KEYS.snap(`r${act.seq}`));
    w.kv.data.set(KEYS.snapIndex, (w.kv.data.get(KEYS.snapIndex) as { id: string }[]).filter((m) => m.id !== `r${act.seq}`));
    const older = KEYS.snap(`r${act.seq - 2}`);
    expect(w.kv.data.has(older)).toBe(true);
    await expect(w.svc(failing(w.kv, [older]), failing(w.mirror, [KEYS.mirrorGen])).openView()).rejects.toThrow("IO error");
  });
});
```

## Appendix C: the security-log matrix (`zz-a4-logmatrix.test.ts`, run in `a4-probe/` and `a4-base/`)

Run with `LOGM_OUT=<file>`; the rows are summarised in A4R-2's table.

```ts
// A4 review (scratch): where the security log entry of a key change is lost, by crash point, on whichever tree this runs in.
// Death model: one process (local storage, mirror, session) dies at write N, before or after it lands. "seen": the code
// reached the page while the process was alive (onCode on the A4 tree; the call's return value on the base tree).
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { checkGeneration, KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { SecurityLog } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { createProtected, legacyDeviceVault, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6 as const, period: 30 });
class Dead extends Error {}
class Proc { calls = 0; dead = false; constructor(public at = Infinity, public mode: "before" | "after" = "before") {} hit() { if (this.dead) throw new Dead(); this.calls++; if (this.calls === this.at) { this.dead = true; return this.mode === "after"; } return true; } }
class ProcKV implements KV {
  constructor(private inner: MemoryKV, private p: Proc) {}
  async get(k: string[]) { if (this.p.dead) throw new Dead(); return this.inner.get(k); }
  async keys() { if (this.p.dead) throw new Dead(); return this.inner.keys(); }
  async set(i: Record<string, unknown>) { const l = this.p.hit(); if (l) await this.inner.set(i); if (this.p.dead) throw new Dead(); }
  async remove(k: string[]) { const l = this.p.hit(); if (l) await this.inner.remove(k); if (this.p.dead) throw new Dead(); }
}
class ProcSession implements SessionCache {
  constructor(private inner: MemorySession, private p: Proc) {}
  async get() { if (this.p.dead) throw new Dead(); return this.inner.get(); }
  async set(d: SessionData) { const l = this.p.hit(); if (l) await this.inner.set(d); if (this.p.dead) throw new Dead(); }
  async clear() { const l = this.p.hit(); if (l) await this.inner.clear(); if (this.p.dead) throw new Dead(); }
  lockEpoch() { return this.inner.lockEpoch(); }
  bumpLockEpoch() { return this.inner.bumpLockEpoch(); }
}
const t = { now: 1_700_000_000_000 };
type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession };
const clone = (w: World): World => {
  const c = (m: MemoryKV) => { const n = new MemoryKV(); for (const [k, v] of m.data) n.data.set(k, structuredClone(v)); return n; };
  const s = new MemorySession(); s.data = w.session.data ? { ...w.session.data } : null; s.epoch = w.session.epoch;
  return { kv: c(w.kv), mirror: c(w.mirror), session: s };
};
const svcOver = (w: World, p?: Proc) => {
  const kv = p ? new ProcKV(w.kv, p) : w.kv;
  return new VaultService({ store: new VaultStore({ kv, mirror: p ? new ProcKV(w.mirror, p) : w.mirror, lock: createMutex(), now: () => t.now }), session: p ? new ProcSession(w.session, p) : w.session, settings: new KvSettingsStore(w.kv), now: () => t.now, security: new SecurityLog({ kv, now: () => t.now }) });
};
async function base(legacy = false): Promise<{ w: World; r1: string | null }> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  let r1: string | null = null;
  if (legacy) await legacyDeviceVault(new VaultStore({ kv: w.kv, mirror: w.mirror, lock: createMutex(), now: () => t.now }));
  else r1 = (await createProtected(svcOver(w))).recoveryCode;
  for (const n of ["GitHub", "AWS"]) { t.now += 60_000; await svcOver(w).mutate((v, c) => addEntry(v, input(n), c).vault); }
  await svcOver(w).openView();
  w.kv.data.delete("sk_security_log");
  return { w, r1 };
}
type Op = { name: string; kind: string; legacy?: boolean; lockFirst?: boolean; run: (s: VaultService, r1: string | null, onCode: (c: string) => void) => Promise<string | undefined> };
const OPS: Op[] = [
  { name: "newRecoveryCode", kind: "recovery_code_new", run: async (s, _r, d) => (await s.newRecoveryCode({ onCode: d } as never)).recoveryCode },
  { name: "rotateKey", kind: "key_rotated", run: async (s, _r, d) => (await s.rotateKey(STRONG, { onCode: d } as never)).recoveryCode },
  { name: "enableMasterPassword", kind: "password_enabled", legacy: true, run: async (s, _r, d) => (await s.enableMasterPassword(STRONG, { onCode: d } as never)).recoveryCode },
  { name: "changePassword", kind: "password_changed", run: async (s) => { await s.changePassword(STRONG, STRONG2); return undefined; } },
  { name: "resetPasswordWithRecovery", kind: "password_reset", lockFirst: true, run: async (s, r1, d) => (await (s.resetPasswordWithRecovery as (...a: unknown[]) => Promise<{ recoveryCode: string }>)(r1!, STRONG2, { onCode: d })).recoveryCode },
];
const rows: unknown[] = [];
describe.each(OPS.map((o) => [o.name, o] as const))("log matrix: %s", (_n, op) => {
  it("counts crash points: committed with no entry; code seen with no entry", async () => {
    const b = await base(op.legacy);
    if (op.lockFirst) b.w.session.data = null;
    const pc = new Proc();
    const cw = clone(b.w);
    await op.run(svcOver(cw, pc), b.r1, () => undefined);
    const total = pc.calls;
    let committedNoEntry = 0;
    let seenNoEntry = 0;
    const seenPoints: string[] = [];
    for (let at = 1; at <= total; at++) {
      for (const mode of ["before", "after"] as const) {
        const w = clone(b.w);
        const p = new Proc(at, mode);
        let seen: string | undefined;
        let ret: string | undefined;
        try { ret = await op.run(svcOver(w, p), b.r1, (c) => { if (!p.dead) seen = c; }); } catch (e) { if (!(e instanceof Dead)) throw e; }
        if (!p.dead && ret) seen = ret; // the base tree: the page shows the returned code
        const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
        const g = (await checkGeneration(w.kv.data.get(KEYS.slot[ptr])))!;
        const before = (await svcOver(b.w).currentGeneration())!;
        const committed = canonicalJson(g.keyring) !== canonicalJson(before.keyring);
        const entries = ((w.kv.data.get("sk_security_log") as { entries?: { kind: string }[] } | undefined)?.entries ?? []).map((e) => e.kind);
        const has = entries.includes(op.kind);
        if (committed && !has) committedNoEntry++;
        if (seen && !has) { seenNoEntry++; seenPoints.push(`${at}${mode[0]}`); if (seen) expect(await unlockWithRecoveryCode(g.keyring, seen).then(() => true, () => false)).toBe(true); }
      }
    }
    rows.push({ op: op.name, writes: total, committedNoEntry, seenNoEntry, seenPoints });
  }, 300_000);
});
describe("log matrix summary", () => {
  it("writes the rows", () => {
    if (process.env.LOGM_OUT) writeFileSync(process.env.LOGM_OUT, JSON.stringify(rows, null, 1));
    console.log(JSON.stringify(rows));
  });
});
```

## Appendix D: the crash-matrix extension (`a4-probe/extension/test/fault/zz-a4-lying.test.ts`)

The file is the package's `test/fault/gm2-crash-matrix.test.ts` up to (not including) its first `describe.each` (the Proc model, OPS, `oldMaterial`, the world helpers), followed by the code below. Run with `A4R_OUT=<file>`: 438 rows, 55 s, every hard invariant holds.

```ts
/** Drops exactly the n-th write (set or remove) of the local store; it reports success. Everything else lands. */
class DropKV implements KV {
  calls = 0;
  dropped: string[] = [];
  constructor(private inner: MemoryKV, private n: number) {}
  get(k: string[]) { return this.inner.get(k); }
  keys() { return this.inner.keys(); }
  async set(i: Record<string, unknown>) { if (++this.calls === this.n) { this.dropped = Object.keys(i); return; } return this.inner.set(i); }
  async remove(k: string[]) { if (++this.calls === this.n) { this.dropped = k.map((x) => `-${x}`); return; } return this.inner.remove(k); }
}
type LRow = { op: string; kind: string; at: string; restart: boolean; dropped: string; outcome: string; opens: string[]; names: string; triple: string; marker: string };
const lrows: LRow[] = [];

async function judge(op: Op, base: Base, w: World, seen: string | undefined, where: string, restart: boolean, kind: string, dropped: string, hard: { triple: boolean; marker: boolean }) {
  if (restart) { w.session = new MemorySession(); await storeOver(w.kv, w.mirror).selfCheck(); }
  const lr = await storeOver(w.kv, w.mirror).load();
  const g = lr.status === "ok" ? lr.gen : null;
  const opens: string[] = [];
  let outcome = "";
  if (!g) {
    const st = (await svcOver(w).openView()).state;
    if (op.name.includes("over lost")) expect(st, where).toBe("lost"); else throw new Error(`${where}: no vault (${st})`);
    outcome = `no vault (${st})`;
  } else {
    if (g.keyring.deviceKey) opens.push("device");
    if (base.pw && (await opensWithPw(g.keyring, base.pw))) opens.push("old pw");
    if (op.typed && op.typed !== base.pw && (await opensWithPw(g.keyring, op.typed))) opens.push("typed pw");
    if (base.r1 && !base.lost && (await opensWithCode(g.keyring, base.r1))) opens.push("old code");
    if (seen && (await opensWithCode(g.keyring, seen))) opens.push("new code");
    const same = base.keyring && canonicalJson(g.keyring) === canonicalJson(base.keyring);
    outcome = same ? "rolled back / unchanged" : "changed";
    if (seen && !opens.includes("new code") && op.name !== "purgeForever") outcome += ", SHOWN CODE DEAD";
    if (op.typed && op.typed !== base.pw && !opens.includes("typed pw") && op.name !== "purgeForever") outcome += ", TYPED PW DEAD";
    expect(opens.length, `${where}: some credential the user holds opens`).toBeGreaterThan(0);
  }
  let marker = "-";
  if (g) {
    const left = await oldMaterial(w, g);
    const r = await storeOver(w.kv, w.mirror).loadView();
    const due = r.status === "ok" ? r.cleanup : "n/a";
    marker = left.length ? `${left.length} old, cleanup ${due}` : `clean, cleanup ${due}`;
    const broken = (left.some((x) => x.startsWith("local:")) && due !== "full") || (left.length > 0 && due === "none");
    if (broken) marker = `PROMISE BROKEN: ${left.join(" ")} cleanup ${due}`;
    if (hard.marker) expect(broken, `${where}: ${marker}`).toBe(false);
  }
  let triple = "-";
  if (restart && g) {
    const c = checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy));
    const m = await checkGeneration(w.mirror.data.get(KEYS.mirrorGen));
    const ok = c && m && canonicalJson(c.keyring) === canonicalJson(g.keyring) && canonicalJson(m.keyring) === canonicalJson(g.keyring);
    triple = ok ? "ok" : "DIFFERS";
    if (hard.triple) expect(ok, `${where}: triple`).toBe(true);
  }
  let names = "";
  if (g) {
    const s = svcOver(w);
    let v = await s.openView();
    if (v.state === "locked") {
      const pw = opens.includes("typed pw") ? op.typed! : base.pw!;
      v = (await s.unlockWithPassword(pw)).view;
    }
    if (v.state !== "unlocked") throw new Error(`${where}: ${v.state}`);
    names = aliveEntries(v.vault).map((e) => e.issuer).join(",");
    // never an account lost: the names before or after the operation
    expect([NAMES.join(","), op.names.join(",")], `${where}: accounts`).toContain(names);
  }
  lrows.push({ op: op.name, kind, at: where, restart, dropped, outcome, opens, names, triple, marker });
}

describe.each(OPS.map((o) => [o.name, o] as const))("lying disk: %s", (_n, op) => {
  it("one local write dropped silently (any index), the run completes; with and without a restart", async () => {
    const base = await op.base();
    if (op.lockFirst) base.w.session.data = null;
    const count = clone(base.w);
    const pc = new Proc();
    const prepC = op.prep ? await op.prep(base, svcOver(count)) : undefined;
    await op.run(svcOver(count, new ProcKV(count.kv, pc), count.mirror, count.session), base, prepC, { alive: () => true });
    const total = pc.calls;
    for (let n = 1; n <= total; n++) {
      const w = clone(base.w);
      const prep = op.prep ? await op.prep(base, svcOver(w)) : undefined;
      const shown: Shown = { alive: () => true };
      const lying = new DropKV(w.kv, n);
      let result: { code?: string } | null = null;
      try { result = await op.run(svcOver(w, lying, w.mirror, w.session), base, prep, shown); } catch (e) { result = null; void e; }
      const seen = result?.code ?? shown.code ?? (op.confirmedBefore ? op.confirmedBefore(prep) : undefined);
      for (const restart of [true, false]) {
        const b = clone(w);
        await judge(op, base, b, seen, `${op.name} drop#${n}(${lying.dropped.join("+")}) restart=${restart}`, restart, "lying", lying.dropped.join("+"), { triple: true, marker: false });
      }
    }
  }, 900_000);
});

describe.each(OPS.map((o) => [o.name, o] as const))("double fault: %s", (_n, op) => {
  it("the process dies at write N; the browser restarts and the self-check dies at its write M; then a clean restart", async () => {
    const base = await op.base();
    if (op.lockFirst) base.w.session.data = null;
    const count = clone(base.w);
    const pc = new Proc();
    const prepC = op.prep ? await op.prep(base, svcOver(count)) : undefined;
    await op.run(svcOver(count, new ProcKV(count.kv, pc), new ProcKV(count.mirror, pc), new ProcSession(count.session, pc)), base, prepC, { alive: () => true });
    const total = pc.calls;
    for (let at = 1; at <= total; at++) {
      for (const mode of ["before", "after"] as const) {
        const w = clone(base.w);
        const p = new Proc(at, mode);
        const prep = op.prep ? await op.prep(base, svcOver(w)) : undefined;
        const shown: Shown = { alive: () => !p.dead };
        let result: { code?: string } | null = null;
        try { result = await op.run(svcOver(w, new ProcKV(w.kv, p), new ProcKV(w.mirror, p), new ProcSession(w.session, p)), base, prep, shown); } catch (e) { if (!(e instanceof Dead)) throw e; }
        if (p.dead) result = null;
        const seen = result?.code ?? shown.code ?? (op.confirmedBefore ? op.confirmedBefore(prep) : undefined);
        // count the self-check's writes from this state
        const probe = clone(w);
        const sp = new Proc();
        await storeOver(new ProcKV(probe.kv, sp), new ProcKV(probe.mirror, sp)).selfCheck();
        const sc = sp.calls;
        for (let m = 1; m <= sc; m++) {
          for (const smode of ["before", "after"] as const) {
            const x = clone(w);
            const q = new Proc(m, smode);
            x.session = new MemorySession();
            await storeOver(new ProcKV(x.kv, q), new ProcKV(x.mirror, q)).selfCheck().catch((e) => { if (!(e instanceof Dead)) throw e; });
            await judge(op, base, x, seen, `${op.name} @${at}${mode[0]} selfCheck@${m}${smode[0]}`, true, "double", "", { triple: true, marker: true });
          }
        }
      }
    }
  }, 900_000);
});

describe("lying/double summary", () => {
  it("writes the rows", () => {
    if (process.env.A4R_OUT) writeFileSync(process.env.A4R_OUT, JSON.stringify(lrows, null, 1));
    expect(lrows.length).toBeGreaterThan(0);
  });
});
```

## Appendix E: the purge probe and the base-tree references

```ts
// A4 review (scratch): purgeForever against another vault's copies kept for "find accounts" (GM2-4 decision, D9).
import { describe, expect, it } from "vitest";
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import { createProtected } from "../helpers/vaults";

const SECRET = "JBSWY3DPEHPK3PXP";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: SECRET, algorithm: "SHA1" as const, digits: 6 as const, period: 30 });
function world() {
  const kv = new MemoryKV(); const mirror = new MemoryKV(); const session = new MemorySession(); const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const store = () => new VaultStore({ kv, mirror, lock: createMutex(), now: () => t.now });
  const svc = () => new VaultService({ store: store(), session, settings, now: () => t.now });
  return { kv, mirror, session, t, store, svc };
}
const active = async (w: ReturnType<typeof world>) => (await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"])))!;

describe("A4R-12 purge and another vault's re-encrypted copies (M2 join)", () => {
  it("REPRO: an account taken from the old vault ('find accounts', added mode) and then purged leaves its secret in the old vault's copies, under the current key", async () => {
    const w = world();
    await createProtected(w.svc());
    w.t.now += 60_000;
    await w.svc().mutate((v, c) => addEntry(v, input("Bank"), c).vault); // vault 1 has Bank
    const vk1 = await vkFromRaw(fromB64(w.session.data!.vk));
    const oldVault = deserializeVault(await decryptVault((await active(w)).envelope, vk1));
    // §3.5 join: a keyring of another vault adopted; the device's old key re-encrypts the old snapshots (kept, own vault id)
    const other = world();
    await createProtected(other.svc());
    const g2 = await active(other);
    const vk2 = await vkFromRaw(fromB64(other.session.data!.vk));
    const empty2 = await decryptVault(g2.envelope, vk2);
    await w.store().transact(async () => ({ envelope: await encryptVault(empty2, vk2, { vaultId: g2.keyring.vaultId, rev: 1 }), keyring: g2.keyring }), { keyChange: true });
    await w.store().finishKeyChange(vk2, async (e) => (e.vkId === vk1.id ? encryptVault(await decryptVault(e, vk1), vk2, { vaultId: e.vaultId, rev: e.rev }) : null));
    w.session.data = { vk: other.session.data!.vk, lastActive: w.t.now, epoch: 0 };
    // "find accounts": Bank added from the old vault's copy, with a new id
    const r = await w.svc().importBackup(oldVault);
    expect(r).toMatchObject({ mode: "added", added: 1 });
    const bank = (await w.svc().read()).vault.entries.find((e) => e.issuer === "Bank")!;
    await w.svc().purgeForever([bank.id]); // "erased from every copy Sixkey keeps"
    const holding: string[] = [];
    for (const [k, v] of w.kv.data) {
      if (!k.startsWith("sk_snap_") || k === KEYS.snapIndex) continue;
      const env = (v as { envelope: EncryptedVault }).envelope;
      if (env.vkId !== vk2.id) continue;
      const plain = deserializeVault(await decryptVault(env, vk2));
      if (plain.entries.some((e) => e.secret === SECRET)) holding.push(`${k} (vault ${env.vaultId === g2.keyring.vaultId ? "current" : "old"})`);
    }
    expect(holding.length).toBeGreaterThan(0);
    expect(holding.every((h) => h.endsWith("(vault old)"))).toBe(true);
  });
});

// ---- a4-base/extension/test/regression/zz-a4-base.test.ts (run on the tree before A4) ----
// A4 review (scratch), run on the tree BEFORE A4: the reference behaviour for A4R-1 and A4R-3.
import { describe, expect, it } from "vitest";
import { fromB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { createProtected, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6 as const, period: 30 });
function world() {
  const kv = new MemoryKV(); const mirror = new MemoryKV(); const session = new MemorySession(); const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const svc = (k: KV = kv, m: KV = mirror) => new VaultService({ store: new VaultStore({ kv: k, mirror: m, lock: createMutex(), now: () => t.now }), session, settings, now: () => t.now });
  const add = async (s: VaultService, n: string) => { t.now += 60_000; await s.mutate((v, c) => addEntry(v, input(n), c).vault); };
  return { kv, mirror, session, svc, add };
}
const active = async (w: ReturnType<typeof world>) => (await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"])))!;
const opensWithCode = (k: Keyring, code: string) => unlockWithRecoveryCode(k, code).then(() => true, () => false);
const opensWithPw = (k: Keyring, pw: string) => unlockWithPassword(k, pw).then(() => true, () => false);

describe("base tree", () => {
  it("A4R-1 reference: the one-call reset in the popup; the popup closes after the code appeared; the user holds P2 and R2 (saved over R1): P2 opens", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    const { recoveryCode: r2 } = await w.svc().resetPasswordWithRecovery(r1, STRONG2);
    const k = (await active(w)).keyring;
    expect(await opensWithPw(k, STRONG2)).toBe(true);
    expect(await opensWithCode(k, r2)).toBe(true);
  });

  it("A4R-3 reference: active copy does not open, mirror throws on every call: the fallback restores the newest local copy", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const vk = await vkFromRaw(fromB64(w.session.data!.vk));
    const act = await active(w);
    w.kv.data.set(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"], { ...act, envelope: await encryptVault(utf8("not a vault"), vk, { vaultId: act.keyring.vaultId, rev: act.envelope.rev + 1 }) });
    const fail = async () => { throw new Error("Internal error opening backing store for indexedDB.open."); };
    const broken: KV = { get: fail, keys: fail, set: fail, remove: fail };
    const v = await w.svc(w.kv, broken).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]); // the newest local copy (the rolling snapshot of the same save)
    expect(v.state === "unlocked" && v.events.map((e) => e.kind)).toEqual(["decrypt_fallback"]);
  });
});
void STRONG;
```

