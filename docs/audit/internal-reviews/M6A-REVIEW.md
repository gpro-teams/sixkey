# M6 Stage A (the Sync section) — security and UX review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "independent" removed from
> the heading and an absolute local path of the live working tree shortened. Paths under `scratchpad/` were the
> reviewer's temporary working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only
> as far as this record quotes it or as it was adopted into the test suite. What became of each finding:
> [`docs/audit/INDEX.md`](../INDEX.md); how to read these records: [`docs/audit/README.md`](../README.md).

**Reviewed:** `M6A.patch` (56 files), applied to a private copy of the repository, read against SYNC-DESIGN rev. 23
(§3.1–§3.5, §4.4, §4.7, §4.9, §6, §7), M5-NOTES §3.13 and §12, and OWNER-DECISIONS/06 and /12. The live working tree
was not modified.

**What was run.** Everything ran under `nice -n 19`, with vitest on targeted files and `--maxWorkers=2`. No end-to-end
tests were run. No commits were made.
- `tsc --noEmit`: clean.
- M6 unit tests (flows, panel, permission, model, helpers, i18n, badge): 114 passed.
- Store, e2e and gate-open builds, each followed by its `check-dist`: all OK.
- Byte comparison against a store build of the unpatched tree.
- 13 probe tests in 6 files, plus 8 hand-made mutants (see "Probes" below).

## Verdict: merge after fixes

The core path is careful and well tested where it was tested. The places it falls down are the ones that were never
exercised:
- a vault that locks while a flow is open;
- a join's outcome other than "enrolled";
- the approval path over unusual local data;
- Cancel pressed while a step is still running.

What must be fixed before merge:
- **One blocker:** R1, lock bypass, two paths.
- **Four majors:** R2 to R5.

None of these defects reaches the store build. The release gate holds: the popup is byte-identical, and no section code,
text or permission request ships (§ Release gate). That is why "merge after fixes" is possible at all. But Stage A *is*
the UI that M8 will switch on by flipping one constant. The fixes belong to Stage A, not to "before the gate opens".

## Findings, ranked

| ID | Sev. | Where | In one line |
|---|---|---|---|
| R1 | **blocker** | `enable.ts:182-199`, `join.ts:289-309`; `sync-flows.ts:452-468` and `:334-378`; `service.ts:764` | A lock does not stop a flow. At a locked page, someone can mint a working recovery code, or press Continue on a join summary and get an unlocked vault |
| R2 | major | `join.ts:200` | The approval join over a lost (unreadable) vault passes `confirmLost: true` by itself, so the user never confirms replacing the data |
| R3 | major | `join.ts:306-308`, `enable.ts:224-229`, `SyncSection.tsx:125-133`, `panel.ts:305-307` | "Unconfirmed" outcomes, and a first round that failed, are announced as "This device joined and is in sync" / "Sync is on". The honest "unconfirmed" screen is never shown, and the round's failure is cleared |
| R4 | major | `JoinView.tsx:174`, `join.ts:326-337` | Cancel is offered while Continue (`commitJoin`) is running. Cancelling removes the permission, the join still happens, and the result is sync on without the permission and a vault replaced although the user cancelled |
| R5 | major | `JoinView.tsx:45`, `m6.py:142`, `enroll.ts:452` | The approval summary says "N added (0 already there are skipped)". After the first round, accounts that were on both sides appear twice. This is an undeclared departure from O6 (M3-NOTES §8 item 6 had flagged it) |
| R6 | minor | `panel.ts:176` vs `:250-255` | Turn-off with the permission withdrawn, then a guard block: the permission is given back, and the review's answer then runs the revocation without it ("unconfirmed"). The comment at :253 is false |
| R7 | minor | `SyncSection.tsx:113-122`, `permission.ts:22-25`, `join.ts:335-336` | `pagehide` and unmount: `cancel()` awaits a storage read (and, for approval, a signed network reject) before removing the permission, so the removal is not guaranteed to run before the page is torn down. This comes from reading the code and was not verified in a browser. Unmount (for example Backup › Restore into the wizard) calls only `dispose()` |
| R8 | minor | `enable.ts:202-222` | `upload()` ends the flow on `locked`, although `FIXABLE` and M6-NOTES §6 item 3 say a locked page keeps the flow. This matters once R1 is fixed |
| R9 | minor | `widgets.tsx:133` | The in-page Confirm focuses its first button, which for "Remove sync identity" and "Delete these saves" is the destructive one. Two Enter presses delete |
| R10 | minor | `model.ts:278`, `m6.py:301` | `prejoin_exists` tells the user to "export or delete" `sk_prejoin`. Part A has no screen for that, so it is a dead end |
| R11 | minor | `m6.py:276` (`syncRemoveBody`) | As the offline-only turn-off, "Remove sync identity" does not say the device stays active in the device list on the server |
| R12 | minor | `m6.py:258/567` | The D6 danger notice says "act now", but its only link is the trash, which does not hold erased accounts |
| R13 | minor | `m6.py` zh_CN | "保存" is used as a noun (`份保存`, `删除这些保存`, `syncParkedTitle`) and reads unnaturally. `syncReviewSecret` "密钥" collides with the sync keys' word. `syncRailOk` with a date substituted gives "已开启 · 2026/10/18 14:00同步" |
| R14 | minor | `panel.ts:44,124-130,175`; `JoinView.tsx:59` | Secrets kept longer than needed: the panel's `#password` lives until a review or older-key confirmation is answered or dismissed (never on lock or hide). The join's typed recovery code stays in view state after Back |
| R15 | nit | `check-dist.mjs:340` | The `sync-engine-*` exemption also applies in the gate-closed branch. Other rules (key names, enrolment fingerprints) catch real section code, but make the exemption depend on `SYNC_UI` |
| R16 | nit | `widgets.tsx:167` | `aria-label` on a `<p>` (generic role) is ignored by some screen readers. Use visually hidden text instead |
| R17 | nit | `enroll.ts:388` | `expiresAt` from the server is not range-checked, unlike `account.ts`'s numbers. The effect is cosmetic: a "NaN:NaN" countdown |

### R1 (blocker): a lock does not stop a sync flow

Phase 0 clears or hides what a lock protects:
- C6-6: `Backup.tsx` empties the export password on every lock epoch and when the tab is hidden.
- The Security section's key cards render only while unlocked.

The M6 controllers never look at the lock. `SyncHost` is rendered whether or not the page is locked (`App.tsx`), so an open
flow stays on screen.

**Path 1, turning sync on.**
1. The user reaches "Make a new one". `prepareUploadRecovery` runs while unlocked, and the new code is shown (`EnableView`
   `mode: "show"`).
2. The user walks away; the idle lock fires, or someone locks from the popup.
3. The code is still on the locked page.
4. Whoever sits down types the two groups. `confirmGroups` calls `commitUploadRecovery`, which writes the keyring prepared
   earlier with the key captured in the handle. It has no `requireVk` and no lock-epoch check.
5. That person now holds a working recovery code. `unlockWithRecoveryCode(fresh)` opens the vault.

Probe `m6r-lock` #1 fails on the patch: the fresh code opens the vault.

**Path 2, joining.**
1. The join is prepared while unlocked (the summary).
2. The vault locks.
3. Someone presses Continue.
4. `commitJoin`, then `committed("sync_on", vk)`, then `startSession(cloud VK)`: the page is unlocked without the master
   password.

Probe `m6r-lock` #2 fails on the patch: the status is `unlocked`.

**Fix (UI side, required):**
- Every controller subscribes to an actual lock: `ctx.status.state` turning `"locked"`, or a `LOCK_EPOCH_KEY` bump since
  the flow captured its key, as `Backup.tsx` does.
- On a lock, the controller drops `#password`, `#code`, `#prepared` and `#plan`, and ends the flow. An "ended by lock"
  state gives the permission back unless sync is on.
- Views stop rendering a recovery code or summary once such a lock happens.
- Key the rule on a real lock, **not** on `vaultState !== "unlocked"`. An empty or lost profile has nothing to lock, and it
  is exactly the profile that joins from the first-run wizard (the path the e2e suite drives).

**Fix (defence in depth, engine side):**
- `commitUploadRecovery` should check the lock epoch it was prepared under, or `requireVk` again.
- `commitJoin` should refuse when the local vault was readable at prepare time and is locked now.

Both engine changes are small. Each needs a line in SYNC-DESIGN §3.5 and §3.1 step 4(b), since they change service
semantics. Then turn the two probes into regression tests.

### R2 (major): the approval join replaces lost data without the user's confirmation

`chooseApproval` passes `...(this.#lost ? { confirmLost: true } : {})` to `ApprovalJoin.start`. No screen on that path
asks anything.

The recovery path does ask: a checkbox, with `confirm_lost` refusing until it is ticked. §3.5 says "需要明确确认才覆盖不可读的残留"
("overwriting unreadable remains requires explicit confirmation"), as Phase 0's restore and start-over do (start-over needs
the user to type DELETE). `sync-flows.ts:343` exists precisely to force that. The M6 engine addition (the `confirmLost`
pass-through) is fine in itself, but the UI satisfies the guard with code. That is what weakens the invariant.

Probe `m6r-approval` R2 fails on the patch: a lost vault becomes `ok` after an approval join in which nothing was
confirmed.

**Fix:** the same checkbox on the `choose` card when `lost`, or a required tick on the `summary` in `lost` mode. Pass
`confirmLost` only from that tick.

### R3 (major): unconfirmed outcomes are announced as success

`JoinFlow.commit` calls `onSyncOn()` for both "enrolled" and "unconfirmed" (`join.ts:306-308`). `EnableFlow.upload` does
the same for "done" and "unconfirmed".

`SyncSection.synced()` then:
1. calls `setFlow(null)` at once, so the flow's own honest screen (`syncJoinUnconfirmed`, `syncOnUnconfirmed`) is never
   rendered;
2. awaits `ctl.syncNow()`, whose result it ignores;
3. calls `ctl.announce(key)`, which sets `done: "syncDoneJoined"` ("This device joined and is in sync.") and
   **clears `failure`**.

So a join whose `complete` never landed, or whose first round is offline, `review_needed` or `remote_unreadable`, shows a
green "joined and in sync". The card beside it may say the opposite.

Probe `m6r-honesty` fails on the patch: the flow ends "unconfirmed" and the page is told only "sync is on".

**Fix:**
- Pass the outcome to `onSyncOn`.
- Keep the flow's "unconfirmed" screen.
- Announce only "done/enrolled", and only when the first round's status is `ok`.
- Never clear the round's failure in `announce`.
- Change "syncDoneJoined" to say what is true ("This device joined.") and let the card speak for the sync state.

### R4 (major): Cancel during an irreversible step

`JoinView` shows its Cancel whenever the state is not ended (`:169-174`), including `summary` with `busy` (`commitJoin` in
flight), `cc` with busy, and `recovery` with busy.

Cancel calls `settlePermission`, which calls `giveBack`. `giveBack` reads `syncOn` before `commitJoin` has written
`sk_sync_cfg`, so it removes the permission. `commitJoin` carries on:
- the local vault is replaced or merged, and the local keyring becomes the cloud's, so the local master password is now the
  synced vault's;
- `sk_prejoin` and `sk_sync_cfg` are written;
- `complete` goes out without the permission, gets a network error, and the result is "unconfirmed".

The screen says "closed". The profile is now "sync on, join unfinished, paused" with a changed master password, after the
user pressed Cancel.

`EnableView` hides Cancel while `uploading`. It shows Cancel during `recovery/confirm busy` (`commitRecovery`), which is
benign because the screen already warns.

Probe `m6r-permission` R5 fails on the patch: the result is `{ syncOn: true, permission: false }`.

**Fix:**
- Hide or disable Cancel while a commit or upload step is busy, as `EnableView` does for `uploading`.
- In `cancel()`, if a commit is in flight, wait for it before deciding about the permission.
- Have `pagehide` treat a busy commit the same way.

### R5 (major): the approval summary claims a dedupe that cannot happen

`ApprovalJoin.prepare` joins an empty cloud vault (`enroll.ts:452`, documented in M3-NOTES §8 item 6: "an account on both
sides appears twice"). The summary says "This profile's 2 account(s) will be added to the synced vault (0 already there
are skipped)". After the first round, the same GitHub account is there twice.

Probe `m6r-approval` R6 fails on the patch. The summary says `{ added: 2, skipped: 0 }`, and there are 2 GitHub entries.

Nothing is lost, but it is a false statement on a confirmation screen. It is also not listed in M6-NOTES §6 or §11.

**Fix, one of:**
- On the approval path, word the summary as "N accounts will be added; any that the synced vault already has will appear
  twice, delete the extra ones";
- or add a dedupe pass after the first round (M3's option 3).

Record it as a departure either way.

### R6 to R17 (minor and nits): details for those the table does not settle

- **R6.** `turnOff(pw, Promise.resolve(true), had = true, a)` runs after line 176 has removed the permission. The fold
  commits with the answer, then the revocation fails, shown as "The server's answer didn't arrive". It is recoverable: a
  second Turn off asks again and succeeds. Probe `m6r-permission` R4 fails on the patch.
  **Fix:** keep the permission while a turn-off review is open, and remove it on dismiss. Alternatively, route the review's
  answer button through `asking(...)` when `!had`.
- **R7.**
  - For `pagehide`: call `chrome.permissions.remove` synchronously, as the first statement, when the flow is not past the
    point where sync is on (the flow knows this without a storage read).
  - For the approval request, a reject cannot be both signed and sent from a dying page. Say "the request expires in 10
    minutes" in M6-NOTES §8 instead of "closing the page rejects the request", or let the worker own the reject.
  - For unmount: add an unmount-only `abandon()` in the cleanup that cancels unless the flow was handed over. The join to
    enable switch at `no_vault` must not drop the permission.
  - Low stakes: the design names the browser-start cleanup as the backstop.
- **R9.** Focus Cancel, or the heading, in danger-tone Confirms.
- **R10.** Make `prejoin_exists` say "this profile already joined once and kept its old vault aside; this version can't
  remove it yet", or ship the `sk_prejoin` screen in Part A.

## The nine departures (M6-NOTES §6)

| # | Judgement |
|---|---|
| 1 no popup screens | Acceptable for Part A, with the measured budget as the reason. It must be recorded in SYNC-DESIGN §6 by its author, because P2 (the lock screen's "password changed on another device") matters to users: without it the popup unlock fails with no explanation after a password change elsewhere. Make P2 a gate-opening item. |
| 2 order of steps | Acceptable. It follows §3.1's numbering. O3's text should be updated by the author. |
| 3 FIXABLE keeps the flow and the permission | Acceptable reading of rev. 23 ("outcome" = the end of the flow). It must be recorded in §7 with the list, since rev. 23 reads literally as "every outcome". It is consistent only once R1 is fixed (a lock ends the flow) and R8 is fixed. |
| 4 typed-back groups | Not a departure from §3.1 4(b), which asks for exactly that. The 30 s clipboard clear only "when allowed" is acceptable. Note that without permission the code stays on the clipboard. |
| 5 parked saves in the Sync section | Acceptable. The author should record it (§4.7 says "安全页", the security page). |
| 6 no store link | Acceptable now. Make it an M8 item (the store ID exists then). |
| 7 badge in the browser's language | Acceptable. Record it. |
| 8 cards without their Part B action | Acceptable only while the gate is closed. It is a gate-opening blocker (`different_vault` and `keys_behind` have no way out). |
| 9 approver on the developer page | Acceptable (dev and e2e only; `check-dist` forbids `devsync/` in prod). |
| **Undeclared:** R2, R5 | Both must be fixed or recorded. R2 must be fixed, since it defeats an engine guard. |

None needs reverting. Items 1, 3, 5, 6 and 7 change §6 and §7 wording and need the design author. Items 8 and 9 hold only
while the gate is closed.

## The three engine additions

- **`EngineStateStore.dismissNotices`.** Fine. It runs under the state lock and removes only by exact (kind, at). Notices
  carry no engine invariant (`lastSynced`, the orphans and the pins are untouched). Two notices with the same kind and the
  same millisecond are both shown, so dismissing both is correct.
- **`ApprovalJoin.expiresAt`.** Fine. It is read-only and display-only. See R17 on range-checking it.
- **`ApprovalJoin.start({ confirmLost })`.** Correct as an engine change: it fixes a real gap, since an approval join over
  a lost vault could not commit before. Its only caller misuses it (R2). The answer still does not reach `prepareJoin` on
  the approval path. That is pre-existing and harmless, because the remote is empty, so the guard cannot block.

## Release gate (verified)

| Check | Result |
|---|---|
| Store build, patched vs unpatched, file hashes | Only `options-*.js`, `options/index.html`, `locale-*.js`, `_locales/*` and `sw.js` differ. Popup HTML and every popup chunk (`popup-*.js`, `errors-*`, `popup-locale-*`) are byte-identical |
| Store build contents | No `assets/sync-*`. `api.sixkey.app` appears only in `manifest.json` and `sw.js`. The only `permissions.request` calls in prod JS are the clipboard pair's. `check-dist` prints "sync user interface: out" |
| Graph guard | Forbids `src/options/sync/`, `catalogs/sync-*.json`, `enroll.ts` and the new-device machine when the gate is closed. No environment variable or flag reaches `syncUiIn` (pinned by `m6-gate`). A closed-gate `check-dist` fails (it does not pass silently) if `catalogs/sync-en.json` is missing |
| Gate opened in a private copy | Builds, `check-dist` (prod) OK, popup **58.3 KB** gz of 60 |
| e2e build | Popup 57.5 KB before, 57.7 KB after. Sync catalogs en 6.7 KB and zh_CN 7.5 KB gz (limit 10). `check-dist --e2e` OK. The permission is required there, so `removeApiPermission` is a no-op by design, and the tests stand in for `chrome.permissions` |

Bypass analysis: a section module imported statically by the page is caught by the graph guard. A renamed chunk is caught
by the key-name scan (quoted or unquoted) and by the enrolment fingerprints. The only soft spot is R15.

## Probes (`probes/`)

To adopt them, drop them into `extension/test/unit/`. They use `test/helpers/m6-kit.ts` and `m3-world.ts`.

| File | Result on M6A | What it shows / guards |
|---|---|---|
| `m6r-lock.test.ts` (2) | **FAIL ×2** = R1 | A confirmation after a lock writes a recovery code that opens the vault. Continue after a lock unlocks the page |
| `m6r-approval.test.ts` (2) | **FAIL ×2** = R2, R5 | Lost data replaced with no confirmation. "0 skipped" followed by a duplicate account |
| `m6r-honesty.test.ts` (1) | **FAIL** = R3 | An "unconfirmed" join is reported to the page as plain "sync on". This prescribes passing the outcome; adapt it to whichever fix is chosen |
| `m6r-permission.test.ts` (2) | **FAIL ×2** = R6, R4 | The review's turn-off runs without the permission. Cancel during Continue leaves sync on without the permission |
| `m6r-wiring.test.ts` (4) | PASS | Static wiring of the views (not covered by M6's mutation run): every `start`, `grant` and `turnOff` sits inside `asking(...)`; each `asking` handler is bound directly or called before any `await`; the handlers passed down are bound to a click directly. **6/6 mutants killed** (`wiring-mutants.py`): grant without asking, grant after an await, turn-off after an await, enable started without asking, the Turn on button behind a reload, the join's restart deferred |
| `m6r-remove.test.ts` (2) | PASS | "Remove sync identity" demotes and never drops: parked saves under an unknown key stay, the accounts stay, and the permission goes last. Locked with an unparked save, it is refused, nothing is removed and the permission is untouched. **2/2 mutants killed** (`remove-mutants.py`) |

The mutant scripts restore each file in a `finally` block. The mutated files were checked identical to the implementer's
afterwards. Run both from `extension/`.

## Open question: split the five shared modules in Stage B, or only re-measure?

**Split in Stage B, early, as a mechanical first commit.** Three reasons:

1. **Gate flip.** M6-NOTES §3 promises that flipping the gate at M8 is a one-constant change. With 1.7 KB of headroom,
   and Part B adding more users of these same modules (the key operations use `keybundle`, `subkeys` and `encoding`),
   re-measuring alone would probably find the overflow at flip time. The flip would then need source surgery under release
   pressure.
2. **Small and pure work.** The popup side needs very little. The popup (`service.ts`) imports only `capPrevious`, a
   3-line pure function, from `keybundle.ts`. `runtime.ts` imports only `createOutboxWriter` from `outbox.ts`.
   **Measured:** moving `capPrevious` alone into its own module, in the gate-open copy, takes the popup from **58.3 to
   57.4 KB** with `check-dist` OK. Splitting `outbox.ts` into the writer the popup needs and the engine-only rest is the
   next and larger step. `local/state.ts` and `encoding.ts` follow.
3. **A guard that sticks.** Add a popup-graph assertion that `crypto/keybundle.ts` is not in the popup graph, so the split
   stays done. Keep `m6-gate`'s gate-open budget test as the backstop.

## Checked and found sound (no finding)

- **Permission asking.**
  - `asking()` calls `chrome.permissions.request` synchronously in every enable, join, retry, grant and turn-off handler.
  - Decline is handled as "declined", and a rejected promise counts as declined.
  - Give-back happens on cancel, failure, `vault_exists`, `keyring_changed` and `cc_mismatch`, and is kept while sync is
    on.
  - Turn-off and remove-identity remove it last; a re-grant is undone on a failed turn-off.
- **Parked delete.** Bound to count plus checksums under the vault lock; a changed list is refused.
- **Review answers.** Reach the engine for round, fold, adopt and remove-identity (turn-off: R6). They bind to `seen`.
  Keep mine is the primary button.
- **Untrusted server data.** Error codes are reduced to `[a-z_]` identifiers. The account numbers are range-checked.
  Nothing from a server message is shown.
- **Logging.** There is no `console` use outside the i18n guard. Nothing is stored in localStorage or sessionStorage.
  Nothing goes into a URL.
- **Fields.** Recovery and group fields are `autocomplete=off`. Password fields follow the page's existing
  `current-password` convention.
- **Accessibility.** Focus moves to each step's heading. Failures are `role=alert`. The card is a polite live region and
  the countdown is not live. The global `prefers-reduced-motion` rule covers the spinner.
- **Rounds.** The page runs no round of its own inside a backoff (the outage fix). Explicit rounds come only from user
  clicks or a flow's end.
- **State-to-card mapping.** Every `SyncStatus` and key state has a card, and the permission is read live. The "paused",
  "resuming", update, rejected, newer, identity-missing and damaged cards are worded honestly. The exception is the
  "done" message (R3).
- **Code hygiene.** No `any`, no `ts-ignore`, no review labels or local paths. Two benign non-null assertions and a few
  `as JoinState` / `as EnableState` casts on spread states; prefer narrowing helpers.
