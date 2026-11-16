# M6 Stage B (managing a sync account): review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "independent" removed from
> the heading. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

**What was reviewed.** `M6B.patch` (58 files), applied on top of current main (Stage A r3 merged), in a fresh private tree
(`m6-review/b/tree`, `python3 scripts/messages.py` run after patching). It was read against SYNC-DESIGN rev. 24
(§3.2, §3.3, §3.5, §3.10, §3.12, §4.7, §4.10, §6, §7, §0.0x) and against M6-NOTES §13.

**What was run.** Everything ran under `nice -n 19`, with vitest `--maxWorkers=2` on targeted files. No end-to-end tests
were run. No commits were made.
- `tsc --noEmit`: clean, probes included.
- M6, source-rule and security-record unit files (22 files, including the builds that `m6-gate` and `m6-check-dist`
  make): 264 passed.
- Module split: the code moved out of the five modules was compared line by line with the new modules. It was moved
  verbatim; the only changes are `HMAC_256` becoming exported and a duplicated `isObject`. Nothing semantic changed.
- New probes: 4 files in `m6-review/b/probes/`. 6 tests fail on M6B, each demonstrating a defect; 1 passes as a control.

## Verdict: merge after fixes

The managing flows follow Stage A's rules carefully:
- permission first in every new handler, with the static wiring test extended to cover them;
- a lock ends every flow; Cancel is hidden while a write runs;
- every new recovery code is shown and two of its groups typed back before anything is sent;
- "unconfirmed" is reported as unconfirmed, not as done;
- security records are written only after the server accepts the action (and a failed record write never fails the
  action).

The SAS approval cannot be given without the user's check: there are three tries against the same pinned SAS, the scam
warning is on both digit screens, and the confirmation code (CC) appears only after the server accepted the approval.

**What must be fixed before merge:** three majors, B1 to B3, plus the one-string minimum fix of B12. B4 is an acceptable
trap only while the release gate stays closed, and must be listed as a gate-opening blocker.

## Ranked findings

| ID | Sev. | Where | Finding |
|---|---|---|---|
| B1 | **major** | `core/sync/engine/keys.ts:246` (`commitRecoveryCodeHeld`) and `:300` (`commitRecoveryResetHeld`) | **The engine does not refuse these key-operation commits after a lock.** Stage A made `commitUploadRecovery` and `commitJoin` refuse with `locked` (rev. 24 (c); §4.10: "同步提交走 `requireVk`", sync commits go through `requireVk`), and `commitRotation` already re-checks `flows.current()` on every pass. These two do not. Their commit sends `PUT /v1/keys` with the proof and keys captured at prepare time, then `commitPublished` → `commitKeys` → `committed()` → `startSession`. So a code shown before the lock is **put into force on the server for every device, and the locked page is unlocked**. The UI ends these flows at a lock it sees (`manage.ts`), but the engine check exists for the locks the UI does not see (an idle expiry nobody read, a failed status read). Probe `m6b-r-lock-engine`: rotation refused (control, passes); a new code and the new password with the recovery code: `{ r: "ok", puts: 1, state: "unlocked" }` (fail). **Fix:** `flows.current()` (the `requireVk` path), with the prepared VK id compared, before `setPending` and the send. Then start the session with the lock epoch read at that check, so that a lock during the send voids it (the same hardening as r2-N3, which also covers `commitRotation`'s final `commitKeys`). |
| B2 | **major** | `options/sync/revoke.ts:87-119`; `ManageViews.tsx:46` (Cancel on the code steps); `syncRevokePartly` | **A "lost or stolen" revocation can end revoked but not rotated, and the screen does not say the protection failed.** The device is revoked first, which is right because it cuts the device off at once. The rotation is prepared afterwards and its code shown. Every way the run can end between the two leaves the keys unrotated: the rotation cannot be prepared (`not_synced`, offline); a lock while the code is shown; **Cancel, which the screen offers on the code steps**. The end screen says only "Revoked before this stopped: 1" plus a generic reason. This also covers the protect-only case (the device wrote the current keys and may have planted a recovery code), where rotating is the whole point. Probe `m6b-r-revoke-lost`: both cases fail. **Fix:** once a lost-path revocation is done, (a) give the code steps no plain Cancel, only an explicit "skip rotating (not safe)"; (b) make every end other than done say "the device is revoked, but the keys were **not** rotated" with a Rotate now button (a new click, so `asking`); (c) record a lasting "rotation still to do" state that the Keys box shows until a rotation succeeds |
| B3 | **major** | `options/App.tsx:130` (`onStartOver={() => setSetup({ mode: "startOver" })}`); `StatusView.tsx:87`; `model.ts:122` | **The lost-vault card's "Start over" skips Phase 0's typed confirmation.** Phase 0 gates start over (which erases the unreadable remains of the vault) behind typing DELETE and the sentence "This permanently discards whatever unreadable data remains." (`Misc.tsx:109-112`). App hands the section an opener that sets the wizard to `startOver` directly. The wizard's own lead then says "Nothing is erased until you finish", and nothing says finishing erases. This is the same class as Stage A's R2 (a destructive overwrite of lost data without the explicit confirmation). Static probe `m6b-r-startover` fails. **Fix:** use the fallback StatusView already has (`location.hash = "#advanced"`, which reaches the DELETE box), or put the same typed confirmation on the card |
| B12 | major (narrow window; minimum fix is one string) | `keys.ts commitRecoveryResetHeld` (the PUT accepted, then `commitPublished`); `m6b.py syncKeyResetBody` | **The new master password set with the recovery code can leave a locked profile with no way in that any screen offers.** Sequence: the page dies, or the local commit fails, after the server accepted the reset. Locally the keyring still holds the forgotten password's wrap and the old code's wrap. The reset screen had said "the one you type now stops working", so the user may have thrown the old code away, and the "keep both codes" screen never appeared. On the locked page, the worker's round says `locked`, so the card is "Locked: Unlock" (Phase 0's password unlock, which the new password fails). The popup's P2 line reads a key status that is not set. The engine's `adoptWithSecret({ password: new })` **does** unlock while locked, but nothing offers it. A fresh profile joined with the new code still works, so this is not permanent loss, but this profile is shut. Probe `m6b-r-reset-crash`: the engine adoption works (passes); the card offers no adoption (fails). **Fix:** (minimum, now) `syncKeyResetBody`/`syncKeyResetNote` should say "keep the old code until Sixkey confirms the change". (Then) while a `pendingRecoveryWrap` is set, or after a failed unlock with sync on, the locked card or the popup line offers "Unlock with the password set on the server" (the adoption) |
| B4 | major, **blocks the gate** (not this merge) | `sync-flows.ts prepareJoin` (`sync.prejoin.check`); `model.ts:111-115` | **The `sk_prejoin` dead end** (Q5): a profile that has an `sk_prejoin` can never join again. The card withholding the rejoin is honest, and the trap is acceptable pre-gate, but it must be fixed before the gate opens. Smallest safe fix in Q5 |
| B5 | minor | `StatusView.tsx:85` (`restore_cloud` → adopt form) | "Restore from the synced vault" does not ask for the permission. The lost-vault card is a local stop, shown before the permission check, so with the permission withdrawn the restore fails as "can't reach the server" and the card offers no Allow. The only ways left are a backup or start over. **Fix:** bind the submit, or the button, through `asking(...)` |
| B6 | minor | none (`m6.py`, `m6b.py`) | §3.10: "吊销最后一台设备：云端库保留，之后只能用恢复码重新入网，UI 警告" (when the last device is revoked the cloud vault stays, rejoining then needs the recovery code, and the UI warns). No warning exists when turning off (revoking itself) the last active device |
| B7 | minor | `ManageViews.tsx` RepairView (`code`), KeyOpView "reset" (`code`) | The typed recovery code is not emptied after submit; only the passwords are. It stays in view state through show, confirm, done and unconfirmed until Close. The field is not rendered, but the code waits in memory past the lock: those end states are "over", so a lock there no longer resets the view |
| B8 | minor | `approve.ts` (no `cancel` override) | Cancelling or closing after "Approve this one" (responded) sends no reject. The request stays responded, and other devices show it as handled elsewhere (their Approve button is disabled) until it expires (10 min). The new device waits with its SAS shown. Send the reject (pw_auth is held until then) |
| B9 | nit | `StatusView.tsx:110,194` | `keysBlocked` includes `update_required`, but the text always says "the server's keys are older than this device's" |
| B10 | nit | `App.tsx` `Security syncOn={syncRail?.on === true}` | Until the section has loaded, Security shows Phase 0's key boxes with sync on; they refuse with `sync_on` |
| B11 | nit (tests) | mutant B5 in `mutants-b-final.log` | "Cancel keeps the secrets" is recorded as *equivalent*. It is not equivalent, only unobserved: secrets kept after a cancel are a real difference. Call it untested |

**Checked and sound:**
- **Server-accepts-first records.** `device_approved` is written after `approveAccepted` (or after the MUST 8 poll),
  `device_revoked` after each revoke, `history_cleared` after the delete. `record()` swallows its own errors, so a
  failed record write never turns a server success into a failure.
- **Approval.** The password is held only until the approval is accepted. The claimed name is shown as text. A request
  handled elsewhere is disabled. A second approval lists only requests still waiting.
- **Device names.** They are opened with the vault key only while unlocked, are taken off the list at a lock, and are
  rendered as text.
- **Delete account.** The order is: the in-page confirmation, then a fresh one-time code, then the password. A stale
  sign-in (`step_up_required`) asks for a new code. After the server deletes, the identity is removed (parked saves
  kept), then the permission is given back last. When the removal could not run, "localLeft" says so.
- **Separate device** (§4.10). It needs pw_auth and the second signature. `switchIdentity` writes the new cfg, clears
  `lastSynced` and the live outbox (allowed by §4.7: the active generation holds it), makes a new `sk_device`, and only
  then writes the IDB identity. The crash window is documented.
- **Reset with the recovery code** (§3.3 step 5). One bundle update replaces both wraps, with `recovery_auth`. The new
  code is shown before it is sent. "Unconfirmed" keeps both codes. `committed_on_server` is reported as done, and the
  device adopts the password the user just set on its next round while unlocked. The exception is a page that dies
  between the accepted PUT and the local commit: see B12.
- **Key ops:** nothing is persisted before the typed-back confirmation; `setPending` is written at commit.
- **Wiring:** every new opener goes through `asking`. The extended `m6-wiring` rules cover `onClick={open.onX}`,
  parametrised openers and starters passed down.

## Q5: the `sk_prejoin` dead end

**When it happens.** A profile that once joined in added mode keeps `sk_prejoin` forever. Turning sync off and Phase 0's
start over both keep it. From then on, every later **added-mode** join is refused with `prejoin_exists`. Rejoining the
*same* account in merged mode still works.

The trap is real in two cases:
- **A different account**, joined after turning sync off.
- **The same account after the vault was lost**: start over (new vaultId), `different_vault`, the rejoin is withheld, and
  the profile can never sync again (the user's only exit is a new browser profile).

**Judgement.** Acceptable while the gate is closed (no users, and the card is honest). It must be fixed before the gate
opens: list it in §9 M8 item 17. It is not worth blocking this merge.

**Smallest safe fix: keep every old vault, don't refuse.**
- **The change.** When an added-mode join finds an older `sk_prejoin` that is not its own (the RR-5 test stays), the join
  goes on and the old record is kept beside the new one, byte for byte. Concretely, `sk_prejoin` becomes a list (format
  v2, append-only), as `sk_sync_orphan` became one in rev. 20.
  - Nothing is decrypted or deleted.
  - §3.5 ④'s "永不自动删除" (never deleted automatically) still holds.
  - The dead end disappears without any new screen.
- **Why not deletion.** Deletion needs a confirmation and loses data.
- **Why not re-import.** It needs a VK the profile may no longer hold (after start over), and it **resurrects** accounts
  the user deleted from the synced vault since the first join.
- **It is not a one-transact change.** I grepped every use of `prejoin` under `src/`. The touch points:
  - `record-writers.ts PrejoinWriter.check`/`writeInLock`: append instead of refusing; the read-back check per entry;
  - `records.ts PrejoinRecord`: the cleanup re-encrypts **each entry** at every key change (`keyOf`/`moved` per entry;
    otherwise an archived entry becomes unreadable after a rotation), registered in `local/port.ts`;
  - `local/keys.ts SYNC_KEYS` (same key, new format) and `SYNC_OFF_KEYS` (kept at turn-off and start over, as now), plus
    `m3-source-rules`' naming rules;
  - the parsers (`parsePrejoin`, accepting v1 as a one-entry list);
  - `SyncSection.tsx SYNC_RECORD` and `SyncHost hasRecords` (unchanged if the key stays);
  - `gateway.ts prejoinKept` and `model.ts different_vault` (the rejoin no longer withheld);
  - the design: §3.5 ④ and §4.7's list wording.
- **Before relying on it, check one pre-existing gap.** `service.ts purgeForever` scrubs the slots, snapshots and mirror
  by identity, but I found no scrub of `sk_prejoin`. The plaintext of the pre-join vault, including accounts erased later,
  appears to survive a permanent delete, contrary to §7's planned PRIVACY sentence ("从它的全部副本清除", purged from all
  of its copies). If that holds, the list form must be scrubbed per entry as well.
- **Size.** About the size of rev. 20's orphan-list change: its own reviewed change, before the gate.
- **Later.** The "Advanced" screen can list, export and (with confirmation) delete entries.

## The other questions

- **Q6, module split and popup.**
  - The split is correct (verbatim move, re-exports kept).
  - `m2-source-rules` is meaningful: it lists the popup's exact sync modules and asserts that the five modules stay out
    of the popup's graph, and a mutant that undoes the split is killed.
  - Gate-open popup: 57.8 KB (−1.9 KB), as the notes report. I did not measure it myself; `m6-gate`, which builds the
    store version with the gate open and runs `check-dist` on it, passed here.
  - P2: read once per failed unlock (no cost on a successful one). The wording is honest about what the popup cannot do.
    One nit: the "keys" variant appears after a plain typo too.
  - Accept the 130 B of P2 strings in the closed store build.
- **Q7, catalog 10 → 12 KB.** Accept. The catalog is lazy, loaded only with the section and never by the popup. 10.6 KB
  gzipped is fine for a settings page, and splitting into a second catalog would add a loader and a check for little gain.
  Keep it under review in later parts.
- **Q7, permission, lock and secrets.** The wiring is sound; B5 is the one gap. Lock: the UI is good, the engine has the
  B1 gap. Secrets: B7. Accessibility: radio groups with a legend, the danger Confirm focuses its title, the CC has
  visually hidden spoken digits and visible digits hidden from screen readers. zh_CN: natural and accurate.
- **Q8, `keys_adopted_back` without a version bump.** OK, since no build reading version 2 has shipped. But
  `security-log.ts` drops unknown kinds on read and every write rewrites the list, so a later downgrade would silently
  lose these entries. Before the first store release, either bump the version or keep unknown kinds when rewriting.
- **Q9, audit hygiene.**
  - **Review labels moved word for word into the split modules** (scrub or map to SYNC-DESIGN anchors):
    `src/core/sync/local/outbox-writer.ts` (R3R-1, R3R-5) and `src/core/sync/local/kept-at-turn-off.ts` (R5R-2).
  - **Design anchors, fine to keep:** `cap-previous.ts` F-11, `write-proof.ts` N3, `devicelist.ts` N22, `keyops.ts` N27,
    `repair.ts` N24/N27.
  - **Pre-existing:** about 70 review-style labels (RR-, M3R-, M3RR-, …) in `engine/keys.ts`, `engine/enroll.ts` and
    `local/sync-local.ts`; the same pass should handle them.
  - No `any`, no `ts-ignore`, no console use, no review paths. The only escapes are three `as ApproveState` casts on
    spread states.
  - Dead code: none found. `ManageFlow.dispose() {}` is an intentional hook.
  - Tests: thorough at the controller level. The gaps are what the probes cover.

## Probes (`m6-review/b/probes/`; drop into `extension/test/unit/`)

| File | Result on M6B | Shows |
|---|---|---|
| `m6b-r-lock-engine.test.ts` (3) | 1 pass (rotation, control); **2 fail** | B1: a new recovery code and a reset with the recovery code, committed after a lock: sent, and the page unlocked |
| `m6b-r-revoke-lost.test.ts` (2) | **2 fail** | B2: revoked for "lost", the rotation not done (rotation could not be prepared; a lock on the code), and the end state does not say so |
| `m6b-r-startover.test.ts` (1, static) | **fails** | B3: the startOver wizard is reachable without the typed DELETE |
| `m6b-r-reset-crash.test.ts` (1) | **fails** at the last expectation (the earlier, observed ones pass) | B12: a reset accepted on the server but not committed locally. The new password fails locally, the old code works, the engine's adoption works while locked, but the locked page's card offers no adoption |

In all: 4 files, 7 tests, 6 failing (each demonstrating a defect) and 1 passing (the rotation control).

The extended wiring test cannot see B5: the adopt form's submit is not in its list of calls that must sit inside
`asking`.

The probes are fix-agnostic:
- B1 asserts the outcome (`locked`, no `PUT`, the page locked).
- B2 asserts only that the end state mentions the rotation.
- B3 asserts that `mode: "startOver"` appears only behind `Misc.tsx`'s confirmed button.
