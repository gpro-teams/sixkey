# M2 review: the sync storage and service layer

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the reviewer line, repository paths updated to the current layout and absolute local
> paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and
> were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the
> test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-17. Reviewer: a Claude Opus review session. Review only: nothing in the main tree was changed except
> this file, and nothing was committed.
>
> **Patch**: `scratchpad/m2/M2.patch` (48 files). It applies cleanly with `patch -p1` on today's main. Main has moved
> since the patch's base (the popup-only catalog package is merged), but none of the 48 files differ between the patch's
> `base/` and main. The strings are not in the patch. I placed `scratchpad/m2/M2-i18n-shard.py` as
> `extension/scripts/i18n/m2.py` and ran `python3 scripts/messages.py`, which gave 431 messages: the 12 `secK*` keys were
> added and nothing else changed.
>
> **Spec read**: SYNC-DESIGN rev. 11 (§0.0e–§0.0k, §2.5, §3.5, §3.9, §3.13, §3.14, §4, §8, §9 M2 row); M2-HANDOFF;
> GM2-REVIEW (Q3 item 4, the hand-off checklist); A4-REVIEW; M1-REVIEW; YUBIKEY-DESIGN §5.1. I read the patch's
> `docs/design/notes/M2-NOTES.md` after forming my own view.
>
> **Scratch** (all under `scratchpad/`):
> - `m2-review/`: main + M2 + the shard. The full verification ran here.
> - `m2-review-base/`: main without M2. This is the "before" reference.
> - `m2-probe/extension/test/regression/m2r-probes.test.ts`: 14 probes, all passing. They pin today's behaviour
>   (Appendix B).
> - `m2-probe/extension/test/fault/m2r-crash-ext.test.ts`: the M2 crash matrix extended with a lying disk and a double
>   fault. The rows are in `m2r-crash-ext.json` (Appendix C).
> - `m2r-mut/mut.py`, `m2r-mut/results.json`: my 31 mutants (Appendix A).
> - `m2r-mut/theirs.py`, `m2r-mut/results-theirs.json`: the implementer's 45 mutants, re-run on today's main + M2.
>
> Line numbers are those of the reviewed tree (`m2-review/extension`).

## Verdict

**MERGE AFTER FIXES.** Only one finding blocks the merge: **M2R-1**. Its fix is small and stays inside M2's own code.
Three Medium findings must be closed before M3 starts. They can go in the same follow-up, and I recommend that.

The storage layer is sound:
- **Crash safety holds.** The M2 crash matrix holds at every crash point, and so does my extension of it: 1300 rows,
  with a lying disk and a double fault (a second death during the restart's self-check and open). Every row that is
  not a lying disk keeps all of these:
  - the vault is the state before or the state after, never a mix;
  - a secret the user holds opens it;
  - the replaced state is a rolling snapshot;
  - lastSynced is cleared;
  - sk_prejoin is written;
  - the marker promise holds;
  - the next open leaves nothing under an old key.
- **Concurrency is safe.** An applyRemote in the service worker, an edit in the popup and an R3 key commit in the
  settings page, started at the same moment, all land with nothing lost (PROBE-10).
- **Sync off is unchanged.** The read gates for open, unlock and degraded unlock are the same numbers as before
  (4, 7, 10; the gate in read-budget.test.ts is 4 and 8). The popup is 53.7 KB gz against the 60 KB budget.

The defects are where M2 meets the M1 adoption rules.

**M2R-1 (High, blocks merge).** The new "adopted back by digest" rule (§0.0i M1 changes 1–2) trusts the identity
record's `adopted`. M2 writes the pins only in a guarded `afterCommit`, and nothing ever repairs them: D8 repairs only
the pinned `vkId`, and only when the VK changed. The extended matrix shows the result. A death anywhere between the
slot commit and the IndexedDB write leaves the commit landed but `adopted` on the previous bundle. That is 8 of the 40–58
crash points of each key commit (12 for the cloud restore). After that:
- a replay or honest rollback of the previous, genuine bundle is adopted back silently, and the device's own new
  recovery code or password is reverted (PROBE-1). Before this patch the same input was `keys_behind`, and the repair
  re-published the user's change;
- the honest current bundle is refused as `auth_without_password` on every round, and an emergency revoke is refused
  with it (PROBE-2, PROBE-2b).

**Counts**: 1 High, 3 Medium, 8 Low, 8 Info.

**Top 3**
1. **M2R-1.** Stale `adopted` after a lost pin write. A same-VK key change is silently reverted by a replayed or
   rolled-back bundle, or every later round is stuck in `auth_without_password` with revoke refused.
2. **M2R-4.** `commitKeys` enforces no key continuity. It writes an older VK's keyring over a newer one and moves the
   pin back (PROBE-7). The storage layer is the last line for F7/R5, and today nothing in it holds that line.
3. **M2R-3 with M2R-2.**
   - The Phase 0 key operations are still allowed while sync is on, and the next round's adopt-back silently reverts
     them (PROBE-4).
   - `preSendCheck` refuses an emergency revoke with `needs_adoption` in the GM2-5 state (PROBE-3). §3.14 says
     revocation is never blocked.

## Verification (in `m2-review/`)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run` | 75 files, **1234 passed**, 1 skipped (main has more tests than the patch's base; the implementer counted 1188) |
| `npm run build` + `check-dist` | OK. Popup **53.7 KB gz** (static 49.8 + zh_CN catalog 3.9); main is 51.2 KB, so M2 adds **+2.5 KB**. The popup catalog has 173 of 431 keys, and none of the `secK*` keys are in it. |
| e2e (`npm run e2e`) | **98 passed, 1 timeout**: `ui-misc.spec.ts` "a clock that jumps 31 days ahead…". It passed 3/3 on a rerun (`--repeat-each=3`), so it is load flakiness, not M2. |
| contract | `check_consistency.py`: 0 hard mismatches. `contract/py/test_contract.py`: 31/31. `test/unit/contract-*`: 45 passed. `contract/` and `api/` are unchanged. |
| read gates (`read-budget.test.ts`, untouched) | Sync off: open 4, lock screen + unlock 7, 0 mirror reads, for 10/100/500 accounts and 2/17 snapshots. Identical to `m2-review-base`. |
| read gates, sync on (`read-budget-sync.test.ts`) | Open 4 and unlock 7, reading the same keys as with sync off. Degraded unlock 10. **The first open after applyRemote: 29** (a full cleanup before the first code; M2R-10). An edit: 9 reads, one more than before, even with sync off (M2R-20). |
| untouched baselines | `enable-crash`, `fault/store`, `keychange-marker`, `gm2-crash-matrix`, `open-view-diff`, `gm2-fixes`, `read-budget`, `perf.spec`, `source-rules`: byte-identical to main, all green. |

## Findings

### M2R-1 (High): `adopted` is never repaired after a lost pin write, and the new adopt-back rule turns that into a silent revert of the user's own key change

**Where**
- `sync-flows.ts:194-197` and `:229`: the pins are written in a guarded `afterCommit`, and a failure is only logged.
  `:286` and `:290` do the same for the join.
- `sync-flows.ts:357`: the doc comment says "D8 repairs it at the next unlock". That is false for `adopted` and
  `maxSeenKver`, and for every same-VK change.
- `identity.ts:86-94` (`setPins`).
- The M1 rule:
  - `adoption.ts:97-104` (the `adoptedBack` branch);
  - `bundle-eval.ts:64-66`, `:81`, `:151`, `:172`;
  - `presend.ts:74-75`.

**Failing sequence (PROBE-1; recovery code)**
1. The device is in its steady state. The pins say `adopted` = bundle K1 (kver 5) and `maxSeenKver` = 5.
2. On this device the user makes a new recovery code (§3.7). The server accepts K2 (kver 6). `commitKeys(K2)` commits
   locally. Then the IndexedDB write of the pins does not happen: the process dies in that window (the extended matrix
   reaches this state at 8 of this operation's 40 crash points, and at every one of the restart variants after
   them), or the IndexedDB write fails, as in GM2-6
   environments. Locally the keyring is K2, but `adopted` is still K1 and `maxSeenKver` is still 5.
3. The server serves K1 again: an honest PITR rollback, or a malicious replay of the genuine bundle.
4. `evaluateSameVkBundle` returns `adopt`. Without the patch's rule it returns `keys_behind`.
5. M3 then runs `commitKeys(K1)`, as documented. The new recovery code no longer opens the vault and the old one does.
   With an honest rollback, the new code is now invalid everywhere.

The user saved the new code and may have destroyed the old one. If they later forget the password, they are locked
out. For a password change the result is the same: the new password silently stops working on this device.

**Second consequence (PROBE-2, PROBE-2b)**
- Same-VK case: after a password change whose pin write was lost, the honest K2 bundle has the same keyring as the
  local one but a different `auth` from the stale `adopted.auth`. So `evaluateSameVkBundle` returns
  `reject: auth_without_password` on every round. `preSendCheck({op: "revoke"})` is refused the same way, which breaks
  "紧急吊销永不被挡".
- Rotation case: after a rotation whose pin write was lost, D8 moves the pinned `vkId` forward but leaves `adopted` at
  the VK1 bundle. Every VK2 round is then `auth_without_password`.

These checks existed in M1. M2's pin write gives them a state they cannot get out of.

**Fix**: make the pins catch up with the commit instead of hoping they were written.
1. **Inside the transact callback, before the commit**: write
   `sk_sync_state.pendingPins = {vkId, vaultId, maxSeenKver, adopted}` (ids, a hash and KDF parameters, no secret).
   - The write is unconditional. Put it in the same `kv.set` call as `clearLastSynced()`'s (which on its own writes
     nothing when `lastSynced` is already null and there is no outbox). For example, give `clearLastSynced` an `extra`
     parameter, or add a `clearAndPin(pins)` that always writes `sk_sync_state`.
   - It is in the same LevelDB as the keyring and written before the commit, so it is present whenever the commit
     landed. The GM2-5 tail loss drops both.
2. **After the commit**: `afterCommit` writes the IndexedDB pins as now, then clears `pendingPins`. Both writes are
   guarded.
3. **Settle before every decision**: add `SyncLocal.settlePins()`, and call it before every adoption or pre-send
   decision and at every unlock. If `pendingPins` is present:
   - If the active keyring is the one it names (`adoptedRecord({keyring: active, auth: pending.adopted.auth}).digest
     === pending.adopted.digest`) and it moves forward (same vault and `pending.maxSeenKver ≥ identity.maxSeenKver`,
     or no pins yet), apply it with `setPins`.
   - In either case, clear it.
4. **While the IndexedDB write keeps failing**, decisions read the facts from `pendingPins`. It is never older than
   the IndexedDB copy.
5. **Optional hardening**: add `adopted.from = SHA-256(canonicalJson(the keyring the commit replaced))` and allow the
   adopt-back only when the local keyring is exactly that keyring, which is the GM2-5 state.

**Tests**
- The "PINS BEHIND" rows of the extended matrix must disappear after `settlePins`.
- PROBE-1, PROBE-2 and PROBE-2b must flip.

**Blocks merge**: yes. Neither this finding nor M2R-2 can be reached until sync can be turned on, so reachability does
not separate them. Two things do:
- **The harm**: this one silently reverts the user's own credential change. Nothing tells the user, and the saved code
  may be the only one left.
- **The fix**: it changes M2's own write mechanism, which M3 calls directly and would otherwise build on: what
  `commitKeys`, `commitJoin` and `afterCommit` write and in what order, plus a new settle step in `SyncLocal`.

M2R-2, by contrast, is a one-line guard inside a pure function, with no change to any interface, and can follow.

**Blocks M3**: yes.

### M2R-2 (Medium): `preSendCheck` refuses revoke (and every other op) with `needs_adoption` in the GM2-5 state

**Where**: `presend.ts:75`.

**Sequence (PROBE-3)**
1. A same-VK change is committed and pinned.
2. storage.local loses its tail. The local keyring is the old one, while `adopted` is the new one.
3. `preSendCheck({op: "revoke"})` returns `needs_adoption`.
4. Before the patch, the same input was `keys_behind`, and revoke went through (verified with `adoptedDigest: null`).

**Fix**: refuse `needs_adoption` only for ops that publish or hand out a bundle (`!allowedWhileKeysBehind(i.op)`).
- For the others, carry on as `behind = true`. The bundle's MAC has been verified, and the proof comes from
  `server.auth`, which matches the server's verifier.
- Add revoke, reject and clear_history to the GM2-5 cases in `m2-local-tail-lost.test.ts`.

**Blocks merge**: no. **Blocks M3**: yes (a pure-function contract M3 calls).

### M2R-3 (Medium): the Phase 0 key operations are not refused while sync is on, and the adopt-back reverts them

**Where**: `service.ts:645`, `:665`, `:763`, `:787`, `:817`, `:844` (`enableMasterPassword`, `rotateKey`,
`changePassword`, `prepareReset` and `commitReset`, `newRecoveryCode`).

**Sequence (PROBE-4)**
1. Sync is on (`sk_sync_cfg` is present).
2. `service.newRecoveryCode(STRONG, deliver)` succeeds and shows a code. Nothing is published.
3. The next round, `evaluateSameVkBundle` on the server's bundle, which is still `adopted`, returns `adopt`. The code
   the user just saved is reverted.

Before the patch the same input was `keys_behind`. Each Phase 0 operation goes wrong in its own way:
- `changePassword` and `commitReset` behave like `newRecoveryCode`;
- `rotateKey` leads to `server_older_key`.

**Fix**: at the top of each of these methods, `if (await this.sync?.context()) throw new ServiceError("sync_on")`.
- That is one read. The popup does none of these operations.
- M6 routes the user to §3.6–§3.8 instead.
- Add a test per method.

**Blocks merge**: no. Sync cannot be turned on before M5/M6. **Blocks M3**: yes.

### M2R-4 (Medium): `commitKeys` enforces no key continuity

**Where**: `sync-flows.ts:199-232`. The local data is opened with `[c.vk, ...c.held]` (`:216`). The caller can put
any key in `held`, so nothing checks that the new keyring reaches the local one.

**Sequence (PROBE-7)**
1. The device is at VK2, and VK2's previous list holds VK1.
2. A caller commits the retired VK1 bundle with `held = [VK2]`.
3. The local keyring becomes VK1, whose previous list cannot reach VK2, and `setPins` moves the pin back to VK1.

M1's `unlockWithSync` and `evaluateSameVkBundle` would refuse this. But the storage layer is the last line for F7 and
R5, and it accepts the commit. The same gap would let a buggy M3 commit a keyring whose wraps nobody has opened, which
is a lock-out (Q3 below).

**Fix**: inside the transact callback, unless `overLost` is set:
- **Same VK** (`c.vk.id === cur.keyring.vkId`): require `previousCovers(realPrevious(cur.keyring, vk),
  unwrappedPreviousIds(bundle.keyring, vk), true)`.
- **Otherwise**: `unwrapPreviousVks(c.bundle.keyring, c.vk)` must contain `cur.keyring.vkId`.
- On failure: `bad_state("discontinuous")`, nothing written.
- **For `overLost`**: SyncFlows can read the identity, so require that the pinned `vkId` (if any) is the bundle's VK
  or one its previous list reaches.

See Q3 for the branded-verdict form.

**Blocks merge**: no. **Blocks M3**: yes.

### M2R-5 (Low): a second added-mode join replaces `sk_prejoin`, which "is never deleted by itself"

**Where**: `record-writers.ts:55-58`; `sync-flows.ts:281`.

**Sequence (PROBE-5)**
1. Profile P has its own vault V0, with an account in the trash. It joins cloud A: `sk_prejoin` holds V0.
2. The user turns sync off. `sk_prejoin` is kept.
3. The user joins cloud B in added mode. `sk_prejoin` is overwritten with A's merged vault.

V0's record, including its trash, is gone. Only re-encrypted snapshots remain, and those age out.

**Fix**: when a `sk_prejoin` exists, refuse the join (a `prejoin_exists` code, so M6 asks the user to export or delete
it first), or keep a list of prejoin records. Keep the "never deleted by itself" promise literally.

**Blocks merge**: no. **Blocks M3**: no (M6).

### M2R-6 (Low): an identity restore racing "turn sync off" in another context brings the removed identity back

**Where**: `sync-local.ts:93-118`. `restoreIdentity` checks the status, opens the copy, then calls `put`. `turnOff`
removes the keys and then the identity. Neither holds a lock across its steps.

**Sequence (PROBE-6)**
1. Context A, on unlock, sees `identity_missing` and opens `sk_sync_cfg`.
2. Context B runs `turnOff` to completion.
3. A's `put` lands.

Result: status `cfg_missing`, with a signing identity present after the user turned sync off.

**Fix**:
- `turnOff` holds the identity lock across both removes.
- `restoreIdentity` re-checks under that lock, just before `put`, that the identity is still absent and
  `sk_sync_cfg` is still present.

**Blocks merge**: no. **Blocks M3**: no.

### M2R-7 (Low): a restored identity is always `enrolled`

**Where**: `sync-local.ts:101`.

**What happens (PROBE-13)**: a device whose `init` or `complete` was never confirmed (`pending`, §3.1 D4, §3.2 M7)
comes back as `enrolled`. M3 then reads the server's `401 unknown_device` as P5's `rejected_by_server` and does not
show "joining not finished".

**Fix**: keep the state in `sk_sync_cfg` (it is not secret), or restore as `pending` and let M3's signed status query
promote it.

**Blocks merge**: no. **Blocks M3**: no (an M3 hand-off item).

### M2R-8 (Low): the rule that keeps sync code out of the popup matches import names, not the popup's module graph

**Where**: `m2-source-rules.test.ts:70-77` and `sync-crypto-hygiene.test.ts`.

**What I tried**
- **A barrel** (`core/sync/local/index.ts` imported by `popup/main.tsx`): the hygiene test caught it.
- **An allowed importer**: I changed `core/sync/local/port.ts` (already in the popup) to import `SyncCfgCopy` from
  `record-writers.ts` and `IdentityStore` from `identity.ts`. Everything passed:
  - all three rule tests;
  - the build;
  - check-dist.

  The popup grew **53.7 → 55.5 KB gz**, and M1's device-backup and the identity store are now in it.

**Fix**: assert on the module graph. `scripts/catalog-keys.mjs` already walks the popup's graph (`collectKeys()`
returns the modules it read). Assert that the graph contains none of:
- `sync-flows.ts`, `sync-local.ts`, `record-writers.ts`, `identity.ts`, `guard.ts`;
- any M1 module other than `constants`, `padding`, and `keybundle` for `capPrevious`.

**Blocks merge**: no. **Blocks M3**: no (before M5 wires more code).

### M2R-9 (Low): the join's "already landed" path writes the pins outside the vault lock

**Where**: `sync-flows.ts:287-293`.

**Race**: a later key commit in another context writes its pins inside the lock, and then this late write lands and
moves them back.

**Fix**: call `pin()` inside the callback, just before `throw LANDED`. The callback holds the vault lock, and taking
the identity lock from inside the vault lock is the allowed order.

**Blocks merge**: no. **Blocks M3**: no.

### M2R-10 (Low): applyRemote's key-change marker has a real cost and no benefit (§0.0i req. 2)

**Where**: `sync-flows.ts:180` (`keyChange: true`).

**What it costs**
- **A cleanup before the first code**: the first popup open after every remote change runs a full cleanup first, 29
  local reads in the 100-account, 17-snapshot fixture.
- **A refused rotation (PROBE-9)**: with 64 previous keys, a local rotation right after a sync is refused with
  `cleanup_pending` until the next open or unlock. The service worker keeps writing new markers.

**Fix**: see Q1. Use `keyChange: false` and amend req. 2.

**Blocks merge**: no. **Blocks M3**: no, but decide before M3 measures the engine.

### M2R-11 (Low): guard answers are matched by entry id only, and three guard behaviours are untested

**Where**: `sync-flows.ts:126-156`.

**Untested behaviours** (my mutants survived):
- **R22**: answering one blocking id unblocks all of them (`every` → `some`).
- **R23**: `secretChanged` ignores an entry that is in this device's trash.
- **R24**: `keepMine` brings back an entry this device had in its trash.

**The answer is not bound to what the user saw**:
1. §4.4 re-pulls before Apply.
2. A server can change an entry's secret between the pull the user reviewed and that re-pull.
3. The new change is then accepted under the old answer.

**Fix**
- Add the three tests.
- Make `MergeAnswer` carry the `GuardReport` it answers (or a digest of each answered entry's remote content). Refuse
  the merge if the recomputed report for those ids differs.

**Blocks merge**: no. **Blocks M3**: no (M3 passes the report back).

### M2R-12 (Low): test gaps behind surviving mutants

- **R31 (not equivalent)**: taking the adopt-back branch when the bundle equals the local keyring (`if (f.adoptedBack)`)
  turns the steady state, "bundle = local = adopted", from `in_sync` into `adopt`. M3 would then commit, and record
  `keys_adopted`, on every round.
  - It survives because every existing M1 test was given `adoptedDigest: null`. The real steady state is never tested.
  - The exhaustive `sameVkVerdict` loop fixes `adoptedBack: false`.
  - The fact-level model never loses a pin or a local tail.
- **R02, R03**: the vault-id checks in the cloud-restore branch (`sync-flows.ts:210`) and in `prepareJoin` (`:237`)
  are untested.
- **R06**: if the runtime port's record list drops `PrejoinRecord`, nothing notices. `sk_prejoin` would then stay
  under the old key after every rotation, and become unopenable once `capPrevious` drops that key. The source rule
  checks only that `vkRecords: sync.records` appears in `runtime.ts`.
- **R20** (②, every live local account survives the join): an equivalent mutant with today's `addAccountsFrom`. It is
  fine as defence in depth.

**Fix**
- Add steady-state cases with the real adopted digest.
- Add `adoptedBack` to the exhaustive loop.
- Add pin-loss and tail-loss events to the T-02 model.
- Add a vault-id test for each branch.
- Add a test on `createRuntime`: a rotation with `sk_prejoin` present leaves it under the new key.

**Blocks merge**: no. **Blocks M3**: no.

### M2R-13 (Info): with sync off, the recovery hook's read can fail a recovery that main completes

**Where**: `store.ts:180-182`, `:272`; `state.ts:52-59`.

**PROBE-8**: one I/O error on the hook's own read fails the recovery of a torn active slot. Main recovers the same
slot. A retry recovers. This is fail-closed and consistent with P-4. Accept it (Q2).

### M2R-14 (Info): a lying disk (the A4R-10 class) reaches three new writes that are never read back

**Where**: the extended matrix's `lie` rows (Appendix C):
- **The join**: if the `sk_prejoin` write is dropped, the join commits without it.
- **The records**: if a record's rewrite is dropped, the record stays under the old key after the marker clears.
- **The pre-merge snapshot**: if `ensureCurrentSnapshot`'s write is dropped, there is no snapshot of the replaced
  state.

**Fix (optional)**: read `sk_prejoin` back inside the join's lock (one get). After the join it is the only complete
copy of the profile's original vault.

### M2R-15 (Info): the new error codes have no text in `src/ui/errors.ts`

- **New service codes**: `too_large_for_sync`, `review_needed`, `different_vault`, `too_large` and `cleanup_pending`
  fall through to the generic "unexpected error". `cleanup_pending` is reachable today from the settings page: a 65th
  rotation while a cleanup is pending.
- **The 5000-account limit**: it now surfaces as an `OpError` with no code, so the generic text. Before, it was
  `invalid_vault`, shown as "check it and try again".

M6 should add the text, and the `cleanup_pending` text before release.

### M2R-16 (Info): the 5000-account check moved to add time

- **Existing users**: none can have more than 5000 entries; the old parser refused any vault above 5000 in total.
- **What changes**: tombstones no longer count towards 5000 at add time, so a vault can now grow past 5000 entries in
  total, and a Phase 0 build cannot read such a vault.
- **The SECURITY.md downgrade note**: §3.13 requires it, but it is not in the patch. It is the doc owner's.
- **Import and restore**: `importBackup` fails at the same point with another error class (M2R-15). `restoreBackup`
  now accepts up to 50 000, as intended.

### M2R-17 (Info): `keepMine` and `addAccountsFrom` rebuild entries from a fixed field list

**Where**: `sync-flows.ts:144-151`, `ops.ts:104-106`.

**Risk**: YubiKey's A package must add `kind` and `ref` there, or copy the entry with a spread instead of a field
list. Otherwise "keep mine" and the join would drop them. This is R3-adjacent: add it to YUBIKEY-DESIGN §2.11's list.

### M2R-18 (Info): a rejoin whose merge the guard stops cannot be answered

**Where**: `prepareJoin`.

**What happens (PROBE-14)**: a rejoin is the same vault under related keys (merged mode). `prepareJoin` throws
`MergeBlocked`, and `JoinInput` has no `answer`, so the user cannot complete the join.

**Fix (M3/M6)**: add `answer?` to `JoinInput`.

### M2R-19 (Info): `reachesLocal` is stricter than the 64-entry exception

This is the implementer's open point 18, and the rule is acceptable.
- **When it bites**: it matters only when the pin differs from the local VK (the GM2-5 state, or a restored old
  storage.local), and when 64 or more rotations have since dropped the local VK from the server's previous list.
- **The result**: `discontinuous` on the remote, then the local keyring is tried, then `remote_rotated` /
  `needs_password`. The device is never locked out of its own data.
- **The way out**: "rejoin from the cloud" (§3.5, `different_vault`), which goes to added mode, because the keys are
  no longer related.

M6 must offer that button for `needs_password` + `discontinuous`. Merging with both keys (open the local keyring with
the same typed secret) is possible, but it is not needed.

### M2R-20 (Info): costs

- **Edits**: one extra storage.local read per edit, even with sync off.
- **The popup**: +2.5 KB gz (records 1.9, store 1.4, ops 0.7, state 0.6, size 0.6, service 0.6, M1 constants 0.45,
  minified). That leaves 6.3 KB for M6, which PHASE0X-PLAN E calls the bulk of the budget.
- **e2e**: one flaky e2e timeout under load (above).

## (1) applyRemote and the commit flows, attacked

**Can a remote cause any of the following?**

| Loss or overwrite | Outcome |
|---|---|
| **Local data loss or overwrite** | No. applyRemote only merges (`mergeVaults` of both sides clamped to `refNow`), inside one transact, after `requireVk` (locked meanwhile: nothing written). A remote erase of a live account, or a changed secret, is stopped by the guard, which re-runs inside the lock. "No change" writes nothing. A merge over 50 000 entries is not committed (D7). A merge over the byte limit is committed. `newer_schema` on either side stops it (the remote is re-parsed, `untrusted()`, `:119`). |
| **Another vault** | Refused (`different_vault`, `:127`; mutant R01 killed). The cloud-restore and join branches check it too, but those checks are untested (M2R-12). |
| **Downgrade of a secret** | Not through applyRemote: the guard blocks `secretChanged`. But see M2R-11 (answer binding) and R23 (a changed secret on an entry in this device's trash goes through). |
| **Deleted accounts** | Trashing never blocks, as designed (D6). An erase that skips this device's trash blocks. |
| **Wrong key** | applyRemote receives plaintext and cannot know which key it came under. R5 ("previous-VK versions are never auto-merged") is M3's job (hand-off item 3). |

**Downgrade of the account's key state (M2R-1, M2R-3, M2R-4)**: yes. This is where the defects are.

**Snapshot before apply**: yes. `ensureCurrentSnapshot` adds a snapshot before the marker and the slot write, and a
failure fails the write. The crash matrix checks it at every point. Mutant R04 (snapshot after the commit) is killed.

**A state where neither old nor new credentials open the vault**
- From a single crash or a double fault: never (the extended matrix, the "nothing the user holds opens it" check,
  0 rows).
- From a caller's wrong verdict: possible, because `commitKeys` writes any keyring it is given (M2R-4, Q3).

**Pins**
- **Never ahead of the commit**: the pins are never ahead, except in the documented tail-loss case and with a lying
  pointer write (the same state as GM2-5).
- **Behind (the D8 window)**: the pins are often behind, which is M2R-1.
- **D8 first direction**: M1's `pinAfterUnlock` returns the forward pin, and `identity.update` writes it, but it moves
  only `vkId`.
- **D8 second direction**: `pin_ahead`, which wins over the server notes (killed mutants M42, R12).

**`identity_missing` / `cfg_missing` / `damaged`**: first-class states in `SyncLocal.status()`. A damaged record is
never read as missing (mutant R28 killed).
- Races: M2R-6 and M2R-7.

**The DSK copy: what a thief with a locked profile copy gets**
- **Without the password**:
  - `deviceId` and `apiOrigin` in clear;
  - the cursor;
  - the signing key and email under K_devbackup(VK).
- **With the password**: the device identity (S1 / A3, as documented). Nothing new beyond §2.5.
- **The IndexedDB copy** of the non-extractable DSK was already in the profile files (A3).
- **After a key change**: the copy is re-encrypted in place, so the old ciphertext lingers only in LevelDB residue.
  Anyone who could use that residue already holds the profile files and the IndexedDB key.

**SW restart mid-apply, two contexts**
- A restart is a crash with or without the session (`restart` true or false in the matrix): sound.
- Three contexts at once: sound (PROBE-10).

## (2) The M1 changes authorised in this patch

- **"Same content" = local keyring or `adopted.digest`, in all three places**
  - It matches §0.0i M1 change 1. The contract vectors are unchanged and green: the adoption vectors take
    `same_keyring` as an input, and every old call site now passes `adoptedDigest: null`, which keeps its old meaning.
  - **The flaw is the trust it puts in `adopted`.** `adopted` is written by a step the design itself allows to fail
    (M2R-1). Before the patch, a stale `adopted` cost at most a missing alarm. Now it causes an adoption.
- **Same-VK adopt-back at once**: correct given a fresh `adopted`.
  - R0 and the history check still run first (mutant R27 killed).
  - `auth_without_password` is still checked first.
  - In the steady state the branch is untested (R31, M2R-12).
- **`needs_adoption` in `preSendCheck`**: correct for the publishing ops, wrong for revoke and the other ops allowed
  while keys are behind (M2R-2).
- **Remote first when the pin differs** (R4 order), and **`reachesLocal`**:
  - Correct. `reachesLocal` only adds a constraint when pin ≠ local (it equals `reachesPinned` otherwise). Acceptable
    (M2R-19).
  - Side effect: with the pin *behind* (D8 first direction), the remote-first order now reaches `afterRemote`'s F-07
    check with a stale `adopted.auth`. It refuses `auth_without_password` and then unlocks locally with
    `remoteRejected` set (PROBE-15: `{kind: "local", pin: VK2, remoteRejected: "auth_without_password"}` after a
    rotation whose pin write was lost). M3 must not alarm on that `remoteRejected` while the pin is behind (part of
    M2R-1's settle).
- **`pin_ahead`**: correct. It wins over the remote notes, and it never moves the pin back.
- **The exhaustive tests (384 → 768)**
  - **`decideRemoteUnlock`**: the loop restates the rule order exactly, and adding `reachesLocal` doubles the space
    honestly. It is a faithful model of the decision function.
  - **`sameVkVerdict`**: its loop pins `adoptedBack: false`, so the new branch is outside it.
  - **The fact-level model**: it never loses a pin or a local tail, so it cannot find M2R-1. Extend both (M2R-12).

## (3) store.ts

**`transact`**: the refactor into `write(fn, opts, recovery)` preserves behaviour for every existing caller (the
untouched baselines are green). The new options:
- **`ensureCurrentSnapshot`**: before the marker; not redundancy (mutants M02 and M25 killed, and R04 killed).
- **`afterCommit` and `event`**: after the commit and the redundancy writes, guarded (M18 killed).
- **`info.cleanupPending()`**: read only when the previous list is full (M11a, M11b and M27 killed).

**`beforeRecoveryWrite`**: called at every site §3.13 lists, plus the FIXa2 rollback (R16 killed). A hook that throws
stops the write (R29 killed). It is called from inside the lock and never calls the store. See Q2 for the two open
points.

**`openVault`'s previous-key fallback** (`:884-904`)
- **Keys**: only the current keyring's really-unwrapped previous keys, and only when the active keyring is the
  session key's.
- **Other vault**: a copy of another vault is never a fallback.
- **R1**: `newer_schema` under a previous key stops it (R15 killed).
- **GM2-7, A4R-3**: unchanged (the `unread` rule).
- **Re-encryption and marker**: a copy under a previous key is re-encrypted to the current key, and the write is a
  key change (the marker; M16, M17 killed).
- **Changed meanwhile**: if the active copy changed since it was read, the write is refused (M26 killed). The refusal
  surfaces as `StorageError("unreadable")`, which shows "could not read its data" for what is only "open again". That
  is cosmetic (Info, part of M2R-15).

**Markers**: see Q1. The previous-VK fallback needs its marker. applyRemote does not.

## (4) Read budgets and size

- **Sync off**: unchanged. Sync on reads the same keys.
- **Cost after a remote change**: the first open after applyRemote reads 29, and that goes away with Q1.
- **Popup**: 53.7 KB gz, under budget.
- **What keeps sync code out of the popup**:
  - `SyncFlows` reaches the service's private members by element access, and is constructed only by the contexts
    that sync.
  - The flows and the local side live in modules the popup does not import.
  - The rule test can be broken through an allowed importer (M2R-8).

## (5) Size cap and limits

- **Measure**: one constant (`SYNC_CONSTANTS.MAX_ENVELOPE_BYTES`) and one measure. `uploadEnvelopeBytes` equals
  `envelopeSizeBytes(envelopeText(env))` of a real upload envelope across 16 KiB edges and revisions, over-measuring
  by at most 15 bytes when the revision is unknown. Mutants R08, R09 and R30 are killed.
- **The trash/erase exemption** is judged from content: same entries; each change is "now erased" or "only the
  deletion register, now deleted".
  - Restore, edit and add are not exempt (R18 killed).
  - The popup's delete and the empty-trash both qualify.
- **5000 at add time, 50 000 at read**: correct (R11 killed). Behaviour changes are in M2R-15 and M2R-16.

## (6) Records

- **`VkEncryptedRecord.reencrypt`**: one critical section under the vault lock that reads the record, checks the
  active key (`activeKeyring`; `superseded`) and writes. A read that throws propagates. `unopenable` never blocks
  the marker.
- **The A4R-4 race** is tested for each real record (`m2-records`; R07 and R17 killed).
- **The duplicated M1 AAD tag and label** are asserted equal to M1's `TAG` and `LABEL`. The moved copy opens with M1's
  `openDeviceBackup` (M28 killed).
- **Mirror-only cleanup skipping the records**: sound. A record can be under an old key only after a transact that
  wrote a full marker:
  - the join writes them inside a keyring-changing transact, with the marker before the commit;
  - `SyncCfgCopy.write` checks the active key under the lock;
  - the restore does not write the copy.
- **The gaps**: the record list's content in the runtime is untested (R06, M2R-12), and the second-join overwrite is
  M2R-5.

## (7) YubiKey reservations

- **R1**: the fallback and applyRemote stop on `newer_schema`. Both are tested (M06, M07, R15).
- **R2**: the grep rule holds. `keepMine` spreads a merged vault (keeping its version) and builds entries by field
  list (M2R-17).
- **R3**: `entryIdentity`, `isPurged` and `addedModeKey` are used in the guard, the cross-vault erase and the join's
  dedupe. The rule test covers `.secret` comparisons.
- **R4**: the test is kept.
- **R5**:
  - `LOCAL_ONLY_KEYS` are not in `SYNC_OFF_KEYS` or in `hasAnyData`, and turning sync off keeps them (R14 killed).
  - `vkRecords` is an open list.
- **R8**: one bump to v: 2 with all twelve new kinds; the `secK*` labels are in options only.
  - **Against the shipped v1 code** (main's `security-log.ts` on a v2 record): `parseSecurityLog` says `newer`,
    `append` and `ack` leave the record byte for byte, and only the password-gated `clear()` rewrites it as v1 (the
    user's intent).
  - The patch's own R8 test uses a stub of the v1 reader. This check uses the real one.

## (8) Tests

**"45 mutants all killed"**: accurate. I re-ran all 45 on today's main + M2: **45 / 45 killed**, all by vitest, none by
tsc only (`m2r-mut/results-theirs.json`).
- They are real single-site mutants, not type errors. Mostly they delete or invert a whole branch, and none sits on a
  boundary.
- None targets the interplay of `adopted` with a lost pin.
- None targets a partial guard answer or the steady state with a real adopted digest.

**My 31 mutants**: **23 killed, 8 survived** (Appendix A).
- R20 is equivalent.
- R02, R03, R06, R22, R23, R24 and R31 are real test gaps (M2R-11, M2R-12).

**Changed existing tests**: each keeps its intent.
- The security-log `v: 1` → `v: 2` (and the "newer" example 2 → 3) is forced by R8.
- The hygiene rule became an allowlist of importers that must each really import, so it is not vacuous.
- `adoptedDigest: null` keeps every M1 case's old meaning. That is also why the steady state with a real digest is
  untested (R31).
- `reachesLocal` was added to the exhaustive loop and to the model with its rule.
- The T-02 sync step passes the model's adopted digest.
- No assertion was weakened.

**`enable-crash` and `fault/store`**: untouched.

## The implementer's three open questions

**Q1. applyRemote's marker (§0.0i req. 2).**

**Revisit req. 2, and drop the marker for applyRemote.** applyRemote writes under the current VK with the keyring
unchanged byte for byte. Its target slot is the other slot, so it can only overwrite old material, never create any.
The snapshot it adds is under the current key. A remote erase is deliberately not cleaned from local snapshots (§4.4),
and the cleanup does not erase content anyway. So the marker buys nothing.

What it costs:
- a full cleanup (29 reads here) before the first code after every remote change;
- the 65th-rotation refusal (PROBE-9).

**Precise change**
- **Design text**: §0.0i req. 2 becomes "只有 `openVault` 的 previous-VK 回退用 `transact({keyChange: true})`。
  `applyRemote` 在当前 VK 与逐字节不变的 keyring 下写入，不写标记（R3 合并经 `commitKeys` 改 keyring，标记自动）". The
  same sentence goes in the `store.ts` header (`:17`).
- **Code**: `sync-flows.ts:180`, `keyChange: false`.
- **Tests**:
  - `m2-service` "merges both sides…" asserts no marker, the same `canonicalJson(keyring)`, and `loadView().cleanup
    === "none"`;
  - `read-budget-sync`'s "first open after applyRemote" asserts ≤ 4;
  - drop mutant M01 or invert it.

**Q2. The recovery hook fails closed, and it skips the redundancy heals.**

**Keep both, as built.**
- **Failing closed**: it is the P-4 rule. Recovering without clearing `lastSynced` is exactly what D1 forbids, because
  it could upload an older state without a merge.
  - With sync off, the hook's read hits the same storage.local the recovery is already reading, so the extra failure
    surface is negligible.
  - A retry recovers (PROBE-8).
- **Skipping the heals**: correct. The heals never change the active generation, and D1's predicate ("the local state
  evolved from `lastSynced`") is about the active generation's checksum.
  - Calling the hook at the mirror heal would make every GoLogin start (IndexedDB wiped on every run) a full pull.
  - **Withdraw GM2-REVIEW's GM2-8 line** "`beforeRecoveryWrite` must still see this write". Clearing `lastSynced` does
    not bring back the newer mirror generation that the heal overwrites. GM2-8's own fix (keep a newer same-vault
    mirror generation as a rolling snapshot before overwriting it) is what protects that data. With sync on, the
    server copy covers it.
  - Record both decisions in §3.13.

**Q3. `commitKeys` trusts the caller's M1 verdict.**

**Do not leave R2 and R3 to M3 convention.** Do three things before M3 writes a caller:
1. **Enforce in `commitKeys` what needs no secret (M2R-4)**:
   - continuity (same VK with previous containment, or the bundle's previous list really unwraps the local VK);
   - for a cloud restore, the pin's reachability and the identity's `vaultId`;
   - `maxSeenKver` never lowered (already enforced).
2. **Make the verdict a capability, like `VerifiedServerBundle` (F-09)**:
   - `evaluateSameVkBundle` (`adopt`), `unlockWithSync` (`adopt`) and the publish path (after the server accepted,
     §3.6.0) return a frozen, WeakSet-branded `Adoption` / `Published` object carrying the bundle, its VK, the previous
     VKs to hold and the new `maxSeenKver`.
   - `commitKeys` accepts only those. R2's "never for `needs_new_password`" and R3's checks then hold by construction,
     and the same-context rule (M1-19) applies to them.
3. **Add a lock-out guard**: the keyring written must be openable by a secret proven in this flow. Either its
   password wrap is byte-identical to the local one (a new recovery code elsewhere, R2), or the `Adoption` carries the
   VK the typed secret opened from `bundle.keyring` (R3, R6, cloud restore), or this device built it.

## Checked and found sound

- The transact refactor, FIXb kept, the marker before the commit, the redundancy and the new options guarded or
  failing as designed.
- applyRemote's design: no network, one transact, `requireVk` inside, clamp and merge, the guard re-run, I10, R1, I6,
  D7.
- `commitKeys`:
  - the keyring written is `bundle.keyring` itself (§0.0i req. 12; M35 killed);
  - `lastSynced` and the outbox are cleared before the commit;
  - the pins come after the commit;
  - the session, then the one cleanup entry point with `held`.
- The join:
  - prepare is in memory and writes nothing;
  - a stale prepare is refused (R19 killed);
  - added mode dedupes against the cloud's live accounts (M32);
  - the vault id is the same but the keys unrelated → added mode (C6-8);
  - `sk_prejoin` and `sk_sync_cfg` are written under the cloud key inside the transact;
  - the local key is held for D9 (M33);
  - a rejoin is not mistaken for a landed retry (M44).
- `purgeForever` reaches another vault's copies by identity (§0.0i req. 13; M22).
- `capPrevious` only with no cleanup pending (§0.0i req. 10). The rotation is refused and writes nothing otherwise.
- The keyring is byte-stable across ordinary saves and applyRemote.
- The identity store:
  - one write;
  - `maxSeenKver` never lowered (M29);
  - damaged is distinct from missing;
  - lock order is vault → identity only.
- `turnOff`'s order: the copy goes first, so a crash between the two removes never resurrects the identity (M30).
- The corrected clock with sync on (M38). The clock offset is clamped to ±7 days.
- The size measure and the exemption. 5000 at add time, 50 000 at read.
- R8 checked against the real v1 code. R4, R5, and the R2/R3 grep rules.
- The read gates with sync off: identical to main.
- Concurrency: three contexts at once.
- Single and double crash faults across all five operations (1300 rows).

## Closing verdict

**MERGE AFTER FIXES.**

- **Before merge**: M2R-1, the pins catch up with the commit, plus its tests.
- **Before M3**, in the same follow-up if possible: M2R-2, M2R-3, M2R-4 and the Q3 capability.
- **Decide Q1** (drop applyRemote's marker) with the design owner before M3 measures the engine.
- **Everything else** is Low or Info, and can follow.

**Counts**: High 1, Medium 3, Low 8, Info 8.

**Top 3**: M2R-1 (stale `adopted` → silent revert or stuck `auth_without_password`); M2R-4 (no continuity in
`commitKeys`); M2R-3 with M2R-2 (Phase 0 key operations with sync on; revoke refused with `needs_adoption`).

## M3 hand-off checklist (exact)

1. **Pins**: call `settlePins()` before every adoption or pre-send decision and at unlock (M2R-1). Feed M1 the
   settled `adopted`, `maxSeenKver` and `vaultId`. While the pin is behind, ignore `remoteRejected:
   auth_without_password`.
2. **Commit only on an M1 verdict**, through the branded `Adoption` / `Published` object (Q3).
   - Never commit on `needs_new_password` until the user's password opened the new wrap (R2).
   - Commit R3 only on `unlockWithSync`'s `adopt`.
   - Pass in `held` the old VK and every local previous VK the cleanup may need.
3. **Remote vaults**: decrypt only with the current VK, and check `envelope.vkId === pinned vkId` and the vault id
   before `applyRemote` (R5, I6). A previous-VK version is used only by "find accounts".
4. **The guard**:
   - run `guardMerge` before `applyRemote`;
   - on `MergeBlocked`, keep nothing of the remote (C1);
   - [Apply] re-pulls and passes the reviewed `GuardReport` with the answer (M2R-11);
   - danger-banner rule as in §4.4 D6.
5. **The outbox**: set `SyncPort.afterCommit` (§4.7, D2). It runs inside the vault lock: no network, no cleanup, no
   identity writes other than in that lock order. On push success, apply the `lastSynced` CAS.
6. **`lastSynced`**: never derive sync state from events (I12). The recovery hook and every key commit or join already
   clear it. Start every round with `needPull` and `dirty` as in §4.1.
7. **D8**:
   - forward: `identity.update` (the `vkId` from `pinAfterUnlock`), together with the settled pins;
   - `pin_ahead` → `needs_password`, R4 order, one password adopts;
   - `pin_ahead` + `discontinuous` → offer "rejoin from the cloud" (M2R-19).
8. **`identity_missing`**: `restoreSyncIdentity({maxSeenVersion: the server's version})`, only once unlocked. Confirm
   the state with a signed status query before treating the device as enrolled (M2R-7).
9. **The rotation (§3.8 P1)**: before calling `capPrevious` in memory, check `store.loadView().cleanup === "none"` (or
   finish the cleanup first). §0.0i req. 10 applies to the sync rotation too, and `TransactInfo.cleanupPending` exists
   only inside a transact.
10. **Pre-send**: `preSendCheck` and its builders run in one JS context (M1-19), with M2R-2 fixed. Revoke is never
    blocked.
11. **R6**: the engine test for `paused_newer` on a v2 remote, including the F6a walk (it stops, it does not go back to
    an older v1 version).
12. **D7**: `applyRemote` throws `too_large` past 50 000 entries. Set the status to `too_large`, and do not retry every
    round. An over-size merge is committed, and only the upload is paused.
13. **The Phase 0 key operations**: refused while sync is on (M2R-3), and M6 routes the user to §3.6–§3.8.
14. **The join**:
    - pass `answer` for the merged mode (M2R-18);
    - handle an existing `sk_prejoin` (M2R-5);
    - `complete` after `commitJoin`.
15. **The marker**: apply Q1's decision (applyRemote `keyChange: false`) and its tests before measuring the engine's
    popup cost.
16. **The popup**: no new imports in `core/sync/local/{port,records,state,size,keys}.ts` beyond what the cleanup and the
    size check need. Land M2R-8's graph check before M5 wires more code.

---

## Appendix A: the reviewer's 31 mutants (`m2r-mut/mut.py`; tsc, then the whole vitest suite)

| Id | Mutation | Result |
|---|---|---|
| R01 | `commitKeys`: no vault-id check (local branch) | killed (m2-service) |
| R02 | cloud restore: no vault-id check | **survived** |
| R03 | `prepareJoin`: no vault-id check | **survived** |
| R04 | `ensureCurrentSnapshot` after the commit (guarded) | killed (m2-store) |
| R05 | pins written inside the callback, before the commit | killed (crash matrix) |
| R06 | the runtime port's records drop `PrejoinRecord` | **survived** |
| R07 | the record step tries only the first held key | killed (m2-records) |
| R08 | the size measure assumes rev 0 | killed (m2-sync-local) |
| R09 | `editFits` `<` instead of `≤` | killed |
| R10 | the banner threshold `>` instead of `≥` | killed |
| R11 | 5000 limit `>` instead of `≥` | killed |
| R12 | `pin_ahead` also when D8 can move the pin forward | killed |
| R13 | restore sets `maxSeenKver` from `maxSeenVersion` | killed |
| R14 | `turnOff` deletes `sk_prf` / `sk_oath` | killed |
| R15 | `newer_schema` under a previous key passed over | killed |
| R16 | FIXa2 rollback without the hook | killed |
| R17 | record step without the `superseded` check | killed |
| R18 | restore from the trash exempt from the size check | killed |
| R19 | `commitJoin` without the "changed meanwhile" check | killed |
| R20 | join without ② (every live local account survives) | survived (equivalent with today's `addAccountsFrom`) |
| R21 | `commitJoin` keeps `lastSynced` | killed (crash matrix) |
| R22 | guard answer: `some` instead of `every` | **survived** |
| R23 | `secretChanged` only for entries alive here | **survived** |
| R24 | `keepMine` revives an entry in this device's trash | **survived** |
| R25 | applyRemote "no change" compared with the remote | killed |
| R26 | `reachesLocal` fact always true | killed |
| R27 | adopt-back without the history check | killed |
| R28 | a damaged identity read as missing | killed |
| R29 | recovery hook fire-and-forget | killed |
| R30 | size check measures the old size twice | killed |
| R31 | adopt-back branch also when the bundle equals the local keyring | **survived** (not equivalent: `in_sync` → `adopt` in the steady state) |

**The implementer's 45, re-run on today's main + M2**: 45 / 45 killed, all by vitest (`m2r-mut/results-theirs.json`).

## Appendix B: probes (`m2-probe/extension/test/regression/m2r-probes.test.ts`, all 14 passing)

- **PROBE-1** (M2R-1): the own new recovery code; pin write lost; replay of the previous bundle → `adopt` (without
  the patch's rule: `keys_behind`); after commit the new code fails and the old one opens.
- **PROBE-2** (M2R-1): the own password change; pin write lost → the honest bundle `auth_without_password`; revoke
  refused.
- **PROBE-2b** (M2R-1): a rotation; pin write lost; D8 moves `vkId` → every VK2 round `auth_without_password`.
- **PROBE-3** (M2R-2): the GM2-5 state → revoke `needs_adoption` (without the patch's rule: allowed).
- **PROBE-4** (M2R-3): Phase 0 `newRecoveryCode` with sync on → succeeds; the next round adopts the old bundle back.
- **PROBE-5** (M2R-5): a second added-mode join replaces `sk_prejoin`.
- **PROBE-6** (M2R-6): a restore racing `turnOff` → `cfg_missing` with an identity.
- **PROBE-7** (M2R-4): `commitKeys` writes the retired VK1 keyring over VK2 and moves the pin back.
- **PROBE-8** (M2R-13): sync off; one hook read error fails a recovery that main completes; a retry recovers.
- **PROBE-9** (M2R-10): applyRemote's marker → the 65th rotation `cleanup_pending`.
- **PROBE-10**: the SW's applyRemote, the popup's edit and the page's R3 commit started together: all land.
- **PROBE-13** (M2R-7): a pending identity is restored as enrolled.
- **PROBE-14** (M2R-18): a rejoin blocked by the guard cannot be answered.
- **PROBE-15** (§2): a rotation; pin write lost (the pin is behind); `unlockWithSync` tries the remote first, refuses it
  as `auth_without_password`, then unlocks locally with the pin moved forward.

## Appendix C: the extended crash matrix (`m2r-crash-ext.test.ts`, rows in `m2r-crash-ext.json`)

**What it adds** to `m2-crash-matrix.test.ts`, with the same five operations and the same invariants:
- `lie`: the Nth write is acknowledged and dropped, and the process goes on;
- a double fault: a second death at write 1–6 of the restart's self-check, open and unlock;
- a row-level record of every invariant instead of the first failed assertion;
- a new "pins behind" observation: the commit landed and `adopted` was not updated.

**1300 rows**: crash point (write number × before/after/lie) × restart variant (restart, no restart, double fault at
1–6). 870 of them are double faults.
- **Single and double crashes**: no invariant violated (0 rows outside `lie`).
- **Pins behind** (the M2R-1 precondition): a death anywhere between the slot commit and the IndexedDB write.

  | Operation | Crash points with pins behind | All crash points | Rows with pins behind |
  |---|---|---|---|
  | commitKeys, same VK | 8 (writes 4–8) | 40 | 64 |
  | commitKeys, R3 | 8 (writes 4–8) | 55 | 64 |
  | cloud restore | 12 (writes 3–9) | 43 | 96 |
  | join (added mode) | 8 (writes 6–10) | 58 | 64 |
  | applyRemote | 0 (no pins) | 19 | 0 |

  For the join, "behind" means `adopted` stays `null`, which is harmless: no adopt-back without a digest. The
  harmful cases are the same-VK commits (PROBE-1, PROBE-2) and the rotations, once D8 has moved the pin forward
  (PROBE-2b).

- **Lie rows**: the A4R-10 class (M2R-14):
  - marker dropped → old snapshots without a marker;
  - record rewrite dropped → `sk_sync_cfg` under an old key after the cleanup;
  - `clearLastSynced` dropped → `lastSynced` survives a key commit;
  - `sk_prejoin` dropped → join committed without it;
  - pointer write dropped → pins ahead (the GM2-5 state).
