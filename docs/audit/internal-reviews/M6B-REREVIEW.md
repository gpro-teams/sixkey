# M6 Stage B, revision 2: focused re-review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. This record is a **re-review of a fix round** (the
> r2 patch, checked against the B1–B12 fixes of [`M6B-REVIEW.md`](M6B-REVIEW.md)); it is not a fresh review of the whole
> change. Edited since: only this note was added, and the file was renamed from `M6B-r2-REVIEW.md`. Paths under
> `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were **not retained**: a probe
> or mutant exists only as far as this record quotes it or as it was adopted into the test suite. What became of each
> finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records: [`docs/audit/README.md`](../README.md).

This review covers `M6B-r2.patch` (78 files), cumulative against current main and applied to a fresh private tree,
`m6-review/b2/tree` (`python3 scripts/messages.py` was run after patching). It covers only the r2 changes and the
B1–B12 fixes, read against SYNC-DESIGN rev. 24 (§3.9 R3, §3.10, §3.14, §3.5 ④, §4.7) and M6-NOTES §13.

**What was run.** Everything ran under `nice -n 19`, with vitest on targeted files and `--maxWorkers=2`. No end-to-end
tests were run. No commits were made.
- `tsc --noEmit`: clean, probes included.
- 34 test files (M6, M2 records, regression, source rules, the security log, the catalog-key collector), including the
  `m6-gate` and `m6-check-dist` builds, plus `test/fault/m2-crash-matrix.test.ts`: every test from the implementer
  passes.
- My earlier probes against r2:
  - B1 (×3), B3 and B12 now pass.
  - B2's two probes are superseded: in r2 nothing is revoked before the code is confirmed, and those probes asserted a
    revocation. The new contract is covered by the implementer's `m6-revoke-rotation.test.ts`.
- New probes in `m6-review/b2/probes/`: 2 files, 4 tests. 3 fail, each demonstrating a defect; 1 control passes.

## Verdict: merge after fixes

Two fixes are needed first: N1 and N2 (both major). Everything else is minor or a policy question.

## Were B1–B12 fixed in substance?

| ID | Status |
|---|---|
| B1 engine lock refusal | **Fixed.** `stillOpen` (requireVk, compared by vkId) runs before `setPending` and before anything is sent, for the new code and for the reset. The rotation re-checks in every pass. **Session epoch:** every key commit's session carries the epoch read just before its open-vault check (`openVault` reads the epoch first, then `flows.current()`). That covers changing the password (epoch from `context`, before the PUT), a new code, a reset, a rotation and a repair. A lock while the request is in flight therefore leaves the page locked. Adoption takes the epoch of its own moment, by design. |
| B2 lost revocation | **Fixed** in the sense asked (nothing revoked before the code is confirmed; a durable "rotation owed" record; a danger card). The reorder **creates N2**. Minor issues with the record: N4–N6. |
| B3 start over | **Fixed:** the card's "Start over" goes to `#advanced`, where the DELETE box is. My static probe passes. |
| B4 kept vaults | **Fixed:** `sk_prejoin` is now a list, appended, read back whole, and deleted only by confirmed id; permanent delete scrubs it. See Q(c). |
| B5 | **Fixed:** restore from the cloud asks for the permission first (`asking` + `panel.permit`). |
| B6 | **Fixed:** turning off the last device warns. |
| B7 | **Fixed:** the typed codes are emptied when their step is left. |
| B8 | **Fixed:** `ApproveFlow.cancel`/`retire` reject an answered request while the password is still held. |
| B9 | **Fixed:** `syncKeysBlockedUpdate`. |
| B10 | **Fixed:** neither box is shown until the sync state is known. |
| B12 | **Fixed:** the reset is recorded as pending before it is sent. While it is pending, the locked card offers the server's password and the popup line points to it. My B12 probe passes. Its new attack surface is reviewed under N1. |

## New findings, ranked

### N1 (major): wrong passwords typed on a locked page through the adoption are not recorded

**Where:** `options/sync/panel.ts adopt` → `engine/keys.ts adoptWithSecret` → `unlockWithSync`.

**Not new in r2.** I checked `cardOf` directly. The `needs_password` and `needs_new_password` cards already offered the
adoption form on a **locked** page in Stage A, because the key status is checked before the round's status. r2's
"Unlock with the server's password" on the locked card is a further way into the same unrecorded surface.

Phase 0 writes every wrong master password to the security record (H6, `unlock_failed`); the user is told "N wrong
passwords since last time" at the next unlock. The adoption answers a wrong password with `rejected` and writes nothing.
It also sends no pw_auth (only `GET /v1/keys`), so the server's `auth_failures` count does not move either. Guesses typed
into any of these forms leave no trace anywhere.

Probe `m6b2-r-adopt-guess`: the Phase 0 control records the failure (passes); the adoption records nothing (fails).

**Fix (one line, covers every way in):** record `unlock_failed` in `adoptWithSecret` on `wrong_secret` (or in the panel),
as `service.unlockWith` does.

The other properties of the new surface check out:
- **No unlock without a password.** It needs a password that opens this device's own keys (then Phase 0's unlock with
  that same password), or a MAC-verified server bundle that passes R2/R3 (the pinned VK, or a continuity-checked new VK).
- **It does accept a password that does not open this device's keys.** That is the server's current password, which is
  §3.9 R3's own unlock order ("先试本地，失败再试服务器", local first, then the server).
- **R3's "older key state, adopt anyway" is reachable on the locked page.** If the server is at an older bundle
  (keys_behind: a backup restored on the server, or a malicious server), a person who knows a former master password can
  open the locked page after confirming. This is the design's accepted "never locked out" residual (RR-6). It is now
  reachable from a locked page, though only while a key change is pending. SECURITY.md should say so, in its account of
  lock strength with sync on.
- **The rest is sound.** There is no lockout in Phase 0 to bypass; the page ends unlocked only by an adoption the typed
  secret proved; nothing leaks beyond the refusal reasons.

### N2 (major): revoking a lost device is now blocked by whatever blocks a rotation

**Where:** `options/sync/revoke.ts:111`, `prepareRotation` before any revocation.

r2 prepares the rotation first. `prepareRotation` needs a full round that comes back `ok` (`not_synced` otherwise),
then the version gate, the pre-send check (keys_behind), and no cleanup pending. So:
- a review the guard is waiting on,
- an update the server requires,
- keys behind,
- a remote that cannot be read,
- or any round that is not `ok`

now stops the revocation itself. §3.14 and M3 keep revoking "never blocked" (`revokeDevice` uses `context({ gate: false })`).

For a device that wrote the current keys ("protect only", the most dangerous case), "lost" is the only reason offered,
so **it cannot be revoked at all** while any of these hold. Some of these states can be caused by that very device: its
erase of an account alive here produces the review.

r1 revoked first and was therefore not affected. Probe `m6b2-r-revoke-blocked`: both cases (a pending review; an update
required) end `failed` with nothing revoked (fail).

**Fix:** if the rotation cannot be prepared for any reason other than a wrong password or a lock, still offer "Revoke
now", with the owed-rotation record written first, the end saying the rotation is owed, and the card offering it.
Alternatively, go back to revoking first with the record (r1 order plus the r2 record). That keeps both the immediate
cut-off and the durable reminder. r2 also delays the cut-off by the time it takes the user to save the new code (notes
item 9); that is a smaller cost, but r1 order plus the record avoids it too.

### N3 to N9 (minor)

- **N3 (minor):** `noteRotationOwed` is written before the first revocation. If the page closes in the seconds between
  that write and the revoke request (`context`, `GET /v1/keys`, then `POST`), the record stays although **nothing was
  revoked**. The danger card then says "A device was revoked as lost or stolen…" and offers a rotation. A user who
  rotates believes the device is out, while it is still enrolled. The device list shows the truth, but the card claims
  more than happened. **Fix:** keep the target ids in the record, and have the card check the device list ("may not have
  been revoked: check, then rotate"), or word the card neutrally.
- **N4 (minor):** turning off or removing the identity deletes the record, with a warning on turn-off only (the
  remove-identity confirmation has none). After that nothing anywhere reminds anyone: the other devices never knew, and
  the planted recovery code, if any, keeps working for the synced vault. Safer: require a tick ("I'll rotate from another
  device") or rotate first. Better still: also write a security-record entry, which survives turn-off, and add the
  warning to the remove-identity confirmation.
- **N5 (minor):** the "moot" rule (`gateway.ts:158`) clears the record as soon as this device's pinned VK differs from
  the record's. A rotation made elsewhere *before* the lost device was revoked also clears it. A lost device that was
  still enrolled could have fetched that bundle (and opened it with the password). Compare against the record's `at` or a
  kver: only a rotation after the record clears it.
- **N6 (minor):** deleting the kept vaults (and Stage A's parked saves) is offered on a **locked** page, with only an
  in-page confirmation. Uninstalling can destroy everything anyway, so this is not an escalation, but it is inconsistent:
  the key and device actions are disabled while locked. Suggest `disabled={locked}`.
- **N7 (minor):** the kept-vault list has no size bound. Every added-mode join appends a whole vault copy into one
  `chrome.storage.local` value, which is rewritten in full at every key change and every permanent delete. TOTP vaults
  are small, so this is fine in practice. If the quota is reached, the join's write fails and the join is refused (safe).
  Note it in §3.5 ④.
- **N8 (nit):** `keptId` hashes the stored JSON. Two identical entries would share an id, and deleting one would delete
  both. It cannot happen with fresh IVs (only with duplicated damaged entries).
- **N9 (nit):** the kept list's rewrite during cleanup and permanent delete is not read back. Only the join's write is
  (accepted residual A4R-10).

## Q(a): the B2 reorder at each point

| Point | Outcome |
|---|---|
| Rotation prepared, code shown or typed back (Cancel, lock, failure) | Nothing revoked, nothing recorded. Correct, **but N2**: any failure to prepare also blocks the revocation |
| Record written, before the first revocation | A refusal or an offline error undoes it. A lock arriving during the write makes the revocation's own `context` refuse, so nothing is revoked and the record is undone. **A page close leaves the record with nothing revoked: N3** |
| Revocations under way | A lock: the revocation in flight completes, the next one is refused, and the record stays ("rotation owed"). A lost answer (`unconfirmed`) keeps the record. Correct |
| Revoked, rotation sent | Accepted: the record is cleared before the local commit, the right moment. Unconfirmed: the record stays and the screen says to keep both codes. A rotation made elsewhere won (changed elsewhere): "rotation owed", then moot once adopted (N5) |
| Turn-off or remove identity | The record is deleted; warning on turn-off only (N4) |

Can a revoked device keep access without the user being told? With r2, no:
- every stop after a revocation says "rotation owed", and the card keeps saying it until a rotation is in effect;
- the remaining gaps are N4 (a deliberate turn-off after a warning) and N5 (the moot rule's edge).

The reverse case is new in r2: a device **not** revoked while the card says it was (N3).

## Q(c): the kept-vault list (format 2)

- **Migration:** a v1 record reads as a one-entry list, unchanged, and becomes v2 at the next write. No shipped build
  reads v1, so there is no downgrade concern.
- **Read-back:** the join's write is verified whole, earlier entries included.
- **Retry:** idempotent. The same cloud key, vault and plaintext are not written twice. RR-5 is kept: the plaintext is
  compared, not the ids alone.
- **Crash matrix:** `test/fault/m2-crash-matrix.test.ts` was run here: 8 tests, all passing. Its scenario
  (`test/helpers/m2-crash.ts`) now includes "added mode over a profile that kept a vault from an earlier join", and it
  allows exactly the documented "commit, then die before the cleanup" window: the entry is kept but unreadable here.
  That residual is acceptable; it mirrors §3.5 ⑥.
- **Delete:** exactly the ids shown, in one write under the vault lock, refused if any id is gone. A cleanup that
  re-encrypts entries between the display and the click changes their ids, so the delete is refused. That is safe.
- **Permanent delete:** scrubs every entry a held key opens (by identity, under the current key) and keeps the others.

**Policy: should permanent delete keep the kept vaults it cannot open?** My recommendation: **keep them** ("demote,
never drop"), **but say so at that moment**. When a permanent delete leaves N unopenable kept vaults, show one line:
"N vaults kept from before a join can't be checked here; delete them in Sync › Kept vaults if those accounts must be gone
everywhere." Then put the same wording in PRIVACY and SECURITY. Deleting them silently would destroy data the user did
not choose; keeping them silently quietly breaks the purge promise.

## Other questions

- **Should Start over count as an erase flow for `sk_prejoin`?** No. The kept vaults are not the unreadable remains Start
  over discards. They are separate copies under the cloud key, possibly readable again after rejoining the same account,
  and sometimes the only copy of data from before a join. Keep them, but **say so** in the DELETE box ("Vaults kept from
  before a join stay; you can delete them in Sync"), so that "erase and start over" is not taken to mean everything.
- **Security log: unknown kinds dropped on rewrite.** **Keep unknown entries** (opaque, counted and trimmed like the
  rest) instead of bumping the version for each new kind. A version bump makes an older build treat the whole record as
  a newer version's and leave it alone, which means it **stops recording** after a downgrade, a worse loss. Decide it
  before the first store release, in Phase 0's record rules.
- **Mutant logs.** `mutants-r2-b.log` lists only one survivor: B5, "cancel keeps the flow's secrets". It is still called
  equivalent. It is not equivalent, only unobserved by the tests (see M6B-REVIEW B11).
- **(e) Other things new in r2.**
  - The catalog-key collector's gate rule (rule 5): sound. The build still fails on a key that the shipped code names and
    the catalog lacks.
  - zh_CN strings: natural and accurate.
  - Accessibility of the new pieces (the kept list, the owed card, the extra unlock form): consistent with the section
    (labels, `role=status`, danger tone).
  - Secrets: the server-password form's field is emptied on lock or hide (`forgetIfLockedOrHidden`).

## Probes (`m6-review/b2/probes/`; drop into `extension/test/unit/`)

| File | Result on M6B-r2 | Shows |
|---|---|---|
| `m6b2-r-adopt-guess.test.ts` (2) | control passes; **adoption fails** | N1: a wrong password typed into the locked card's server-password form is not recorded (Phase 0's unlock records it) |
| `m6b2-r-revoke-blocked.test.ts` (2) | **both fail** | N2: a protect-only lost device cannot be revoked while a review is pending, or while an update is required |
