# M6 Stage A, revision 2: focused re-review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. This record is a **re-review of a fix round** (the
> r2 patch), focused on the first review's findings and on what r2 added; it is not a fresh review of the whole change.
> Its first review is [`M6A-REVIEW.md`](M6A-REVIEW.md). Edited since: only this note was added, and the file was
> renamed from `M6A-r2-REVIEW.md`. Paths under `scratchpad/` were the reviewer's temporary working copies (probes,
> mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was
> adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these
> records: [`docs/audit/README.md`](../README.md).

**Scope.** A focused re-review of the r2 patch, not a repeat of the first review (`M6A-REVIEW.md`).
- **Patch:** `M6A-r2.patch`, cumulative against main, applied to a fresh private tree (`m6-review/r2/tree`). It changes
  14 source files and adds `lock.ts` and 6 new test files.
- **Read:** every source diff against r1, plus `M6A-r2-NOTES.md` and `mutants-r2.log`.

**What was run.** Everything ran under `nice -n 19`, with vitest on targeted files and `--maxWorkers=2`. No end-to-end
tests were run. No commits were made.
- `tsc --noEmit`: clean.
- All M6 unit tests (15 files): 172 passed.
- My first-round probes against r2: 12 of 13 pass. The one failure is R5, by design: its contract was changed, see Q2.
- Store build rebuilt and hashed against unpatched main:
  - the popup is still byte-identical;
  - the files that differ are the same set as in r1;
  - `check-dist` prod reports OK, "sync user interface: out".
- e2e build: `check-dist` OK, popup 57.7 KB, sync catalogs en 6.9 KB and zh_CN 7.7 KB gz.
- New probes: `r2/probes/m6r2-edges.test.ts`, 3 tests, **all fail on r2**. Each demonstrates one of N1, N3 or N4.

## Verdict: merge after fixes (small)

R1 to R17 are fixed in substance, not only to satisfy the probes. The engine-side lock checks are correct and fail
closed. What is left is minor: N1 to N5 below. None reaches the store build, and none loses data.

The first review held that fixes to this UI belong to Stage A, not to "before the gate opens". N1 and N2 are the same
class as R1 (what survives a lock or an ended run), and each is a few lines, so they are not deferred.

**Must do in this change:**
1. N2 (it includes the pre-ticked "replace unreadable data" box).
2. N1.
3. N3's wording in M6-NOTES §11.

**Follow-ups, before the gate opens:**
- N3's epoch hardening;
- N4;
- N5.

## Q1: are R1 to R17 really fixed?

| ID | Status | How it was checked |
|---|---|---|
| R1 lock bypass | **Fixed, two layers.** | **Engine:** `commitUploadRecovery` calls `requireVk` inside its transact, after the LANDED check. `commitJoin` calls `stillOpen` before its transact and again inside it, after the base check. Both fail closed with `locked`. **UI:** `watchLock` and the view's unlocked-to-locked edge end the flows, and drop `#password`, `#code`, `#prepared`, `#plan` and the approval request. My r1 probes pass. Residual: N1, N2, N3 |
| R2 lost data replaced without consent | **Fixed.** | The tick is on the warning card for both ways in. `ready()` refuses without it. Only `#confirmedLost` reaches the engine. Mutant C2 ("confirmLost for any lost profile") survives, and that is legitimately equivalent: no path gets past `ready()` without the tick |
| R3 false "in sync" | **Fixed.** | The outcome is passed to `onSyncOn`. `settled()` announces only after a round that went through with status `ok`. `announce` no longer clears the failure. The "unconfirmed" screen stays, with a "Got it" button. "syncDoneJoined" now says "This device joined." |
| R4 Cancel during a write | **Fixed.** | Cancel is hidden during the join's Continue, the upload, and the code's write. `cancel()` waits for `#writing`, and `giveBack` checks `syncOn` afterwards. Tests cover the join and the upload |
| R5 dedupe claim | **Fixed by honest wording** (Q2) | |
| R6 turn-off review without the permission | **Fixed.** | `#heldForReview` tracks it. `answer()` passes the original `had`. `closeReview` gives back only what the click granted. Residual: N4 |
| R7 pagehide and unmount | **Fixed** as far as a page can. | `leaving()` is decided synchronously, and `dropPermission` issues `chrome.permissions.remove` before its first await. The panel's `leaving()` releases a review's hold. Unmount calls `cancel()`. A replaced flow calls `retire()`. MUST 6 is honestly downgraded to "best effort, and the server expires the request" |
| R8 | **Fixed.** | `locked` was removed from `FIXABLE`. A lock now ends the flow, except the join's warning card when the page was already locked, which is a deliberate fix-in-place |
| R9 to R17 | **Fixed.** | R9: a danger Confirm focuses its title. R10: the `prejoin` text is honest. R11: the removal text names the device list. R12: the danger notice links to backups. R13: zh_CN wording, see "New in r2". R14: the panel password is forgotten on lock or hide, and the fields are emptied through `forgot`. R15: the `sync-engine` exemption is gone. R16: visually hidden text replaces the `aria-label`. R17: `expiryOf` and `clock(NaN)` |

**`lock.ts`, "a lock = the epoch moves *and* the service says locked".** This rule is sound.
- **Profiles with nothing to lock.** The service never reports "locked" for an empty or unreadable profile. A device-key
  profile is always unlocked (`currentVk` uses the device key). So the first-run join goes on, which is correct: nothing
  is protected there.
- **Timing that could leave a flow alive:**
  - **A re-unlock between the epoch bump and the status read.** Only someone with the password can do that.
  - **An idle expiry nobody reads.** In "lock every time" mode no worker alarm runs; idle mode has one, via `sw.ts`. The
    epoch does not move, so nothing fires, but any commit calls `requireVk`, which detects the expiry, clears the session
    and refuses.
  - **`status()` rejecting.** It is swallowed, but the engine checks still hold.
  - In all three cases the engine layer is the real guarantee. The UI layer is about secrets on screen.

## Q1 continued: the declared exception (dismissing a turn-off review restores the withdrawal)

**Acceptable.** The user had withdrawn the permission in chrome://extensions. The Turn off click re-granted it, and only
for that turn-off. Abandoning the turn-off puts the profile back exactly where the user put it: sync on, paused
(`permission_removed`). The design supports that state fully: nothing is sent, nothing is lost, and Allow again works.

Keeping a permission the user had removed, after they abandoned the action it was granted for, would be the worse choice.
The invariant "sync on ⇒ the permission is held, or the user withdrew it" holds. Record the exception in SYNC-DESIGN §7
with departure 3.

## Q2: the R5 probe change

**Acceptable.** The new contract matches what the code can honestly do in Part A. On the approval path, the summary says
"an account the synced vault already has will appear twice", gives no skipped count, and both copies exist after the
first round. The recovery path keeps its real count.

It is recorded as departure 10, with M3's options. My r1 probe asserted a dedupe that cannot exist without a contract
change or a post-round dedupe pass, so it is superseded. Recommend the dedupe pass early in Part B: duplicates of a 2FA
account are confusing, even though nothing is lost.

## Q3: the new engine rules in `sync-flows.ts`

Neither rule weakens an invariant. Both only add refusals (fail closed), checked by reading and by the r2 tests.

**`commitUploadRecovery`:**
- `requireVk(cur.keyring)` comes after the LANDED short-circuit, so a retry of a write that landed is still "done".
- It comes after the `noSync` and base checks, inside the same transact, so there is no time-of-check gap.
- It runs with sync off, so there is no outbox or orphan interaction.

**`commitJoin`:**
- `stillOpen` runs only when the join was prepared with this profile's vault open (`localVk` and `baseKeyring`). Empty and
  lost joins are unaffected.
- Inside the transact it comes after the LANDED and base checks.
- The orphan fold happened at prepare time (`foldForJoin`). The guard and the `sk_prejoin` logic are unchanged.

**UX consequence (correct, not a defect):** an idle lock during a long approval now ends the join at Continue.

## New in r2: findings

| ID | Sev. | Where | Finding | Probe |
|---|---|---|---|---|
| N1 | minor | `enable.ts:98`, `join.ts:124` | A lock while Chrome's permission prompt is open ends the flow (`locked()`, then `end`, then `giveBack` with nothing granted yet). The user then answers Allow, and `start()`'s continuation sees a dead run and returns, so the permission stays granted with sync off until the next browser start | `m6r2-edges` N1 **fails** |
| N2 | minor (fix now) | `EnableView.tsx:44-47`, `JoinView.tsx:58-60` | View state survives a run that ended (by a lock or a failure) and comes back on "Start again". (a) A master password typed but not submitted (`pw`) and a typed recovery code (`code`, both views) **pre-fill** their fields. In the join this is the vault's recovery code, in a `type=text` field, once a new sign-in reaches that step. Exploiting it needs the email as well, or devtools, but it breaks the rule R1 restores. (b) **The worst case:** JoinView's `lost` checkbox (`useState`, line 60) stays ticked, so the choose card comes back with "replace this profile's unreadable data" already confirmed. That is a pre-filled destructive confirmation, the class R2 removed | by reading |
| N3 | minor | `sync-flows.ts` `commitJoin`, then `service.ts committed()`/`startSession` | M6-NOTES §11's residual window is real but understated. A lock after the in-lock `stillOpen` check and before `startSession` reads the epoch leaves the locked page **unlocked** under the cloud key. That stretch covers the vault encryption, `sk_prejoin`, the cfg and pins, the two-slot write with read-back, `afterCommit` and the security record: it is not "one storage write". It is acceptable as a documented residual, because it needs a lock within tens of milliseconds of the user's own Continue (for example a screen lock right after), and Phase 0's key changes share it | `m6r2-edges` N3 **fails** (page `unlocked`) |
| N4 | minor | `panel.ts` `forgetPassword` and `closeReview` | Hiding the tab while a turn-off review's answer is running closes the review and gives back the permission it holds, under the revocation. The turn-off then fails as "unconfirmed". It is recoverable: Turn off again, and the revocation is idempotent | `m6r2-edges` N4 **fails** |
| N5 | nit | `m6.py` `syncFailLockedOut` | "nothing was turned on" is wrong in one case: a lock that interrupts `firstUpload` after its step 5 has written a pending cfg. The card then says "turning sync on didn't finish". Suggest "…Sixkey locked, so this stopped. Unlock, then check below or start again." | by reading |

**Suggested fixes:**
- **N1.** In both `start()`s, on a dead run with `ok`, give the permission back **only if the flow is OVER/closed** (ended
  by a lock). A superseded run must not give it back: a double click on "Ask again" would otherwise drop the permission
  the newer run needs.
- **N2.** Reset each view's local state when its flow reaches failed or closed (an effect on `s.at`), or key the view on a
  per-run id.
- **N3, notes:** fix the §11 wording in this change.
- **N3, hardening (about 5 lines):** read `lockEpoch()` just before the in-lock `requireVk` check and give `committed()`
  and `startSession` that epoch instead of reading it afterwards. A lock anywhere in the window then voids the new session.
  The same change closes the window for Phase 0's key changes.
- **N4.** Don't close a review from `forgetPassword` or `locked` while `doing` is that review's own action; let
  `turnOff`'s ending decide. A lock still voids the key anyway.

**Checked in r2 and found clean:**
- **Flow replacement:** `replace()`/`retire()` along join to enable at `no_vault`, enable to join after `vault_exists`,
  and the handover.
- **Unmount cancel in the join-only page:** `setFlow(null)` runs before `onJoined` for enrolled, and an "unconfirmed" join
  is left alone.
- **StatusView hooks** sit before the early return.
- **New a11y:** the title focus and the visually hidden SAS text are correct, and the `#sync .vh` scope holds.
- **New zh_CN strings** read naturally: 改动 for the kept saves, "上次同步：$1", "账户的密钥", the "出现两次" summary and
  `syncFailLockedOut`.
- **No new logging or storage of secrets.**
- **Mutant log:** 76 killed. C2 survives and is truly equivalent. R3 was re-run and killed after its test was added.

## Probes

- `m6-review/r2/probes/m6r2-edges.test.ts`: 3 tests, all fail on r2, each demonstrating N1, N3 or N4. Put it in
  `extension/test/unit/`.
- Each test is fix-agnostic. It asserts the outcome: no permission left after the lock; the page stays locked; the
  answer's revocation holds the permission.
- My r1 probes are superseded by the implementer's adopted versions. `m6r-approval.test.ts` does not typecheck as
  written: TS narrows the state across awaits. Do not adopt it.
