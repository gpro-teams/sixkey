# M3 re-review: the fixed sync engine and FakeServer (revision 2)

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: repository paths
> updated to the current layout and absolute local paths shortened. Paths under `scratchpad/` were the reviewer's
> temporary working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only as far as
> this record quotes it or as it was adopted into the test suite. What became of each finding:
> [`docs/audit/INDEX.md`](../INDEX.md); how to read these records: [`docs/audit/README.md`](../README.md).

Date: 2026-10-18. Reviewed: `scratchpad/m3/M3.patch` (revision 2: 36 files, 10,239 lines), applied with `patch -p1` to a fresh
rsync of the repository in `scratchpad/m3-rereview/` (`node_modules` symlinked). Spec: SYNC-DESIGN revision 17 (§0.0e–§0.0q,
§3, §4, §9 M3/M5 rows), the patch's `docs/design/notes/M3-NOTES.md` (§0 findings table, §3 items 19–24, §10 the M5 hand-off),
`docs/audit/internal-reviews/M3-REVIEW.md` (the first review and its probes), M2-NOTES §7, `api/openapi.yaml` and the real M4 server (`api/server`,
read only; its suite run in a separate copy).

**Revision 18 (§0.0r, the M4 cleanup round) landed in the main tree during this review** (SYNC-DESIGN 04:40, contract
04:41–04:45). It changes the contract's rate-limit texts and makes the Content-Type rule exactly `application/json` with an
optional `charset=utf-8`. Nothing in `src/` changed. The patch applies cleanly to that tree too (`scratchpad/m3-rereview-r18/`,
§0), and none of my findings changes because of it. The one consequence is FS-1 (§5): the FakeServer still accepts
Content-Type values that revision 18 now refuses.

Every finding marked **confirmed** has a probe that fails on the patch as submitted. All of the probes are in the scratch copy:
- `extension/test/unit/m3rr-probes.test.ts`: 14 tests. 11 of them fail on the patch; the 3 that pass are sanity controls.
- `extension/test/unit/m3rr-rotation-fuzz.test.ts`: a seeded fuzzer for rotation races.
- `extension/test/unit/m3rr-replay.test.ts`: replays the long model's failing seed (M3RR-13).
- `extension/test/review/m3rr-fs-probes.test.ts`: the FakeServer's differences from M4. Run it with
  `vitest.m3rr.config.ts`.

My mutation runner is `scratchpad/m3rr-scripts/mut.py`. Its results are in `scratchpad/m3rr-mut-results.json` and the logs are
`scratchpad/m3rr-*.log`. The only file changed in the main tree is this one.

**In one paragraph.** The two write-path fixes hold.
- **M3R-1:** the round now loads the vault before it reads the sync state, on every attempt and on the locked path.
- **M3R-2:** the rotation's base is lastSynced, checked against the server's version and head.

Nothing I tried breaks either: every load that can recover, two contexts recovering at the same moment, both slots torn, and
71 fuzzed rotations with interleavings, lost answers and partitions, none of which lost data. Three of the fixes, however,
introduced regressions:
- **M3RR-1 (medium, from the M3R-2 fix).** A rotation whose answer was lost, retried with the same handle, now ends in
  `not_synced` ("nothing was sent, the code shown is not invalid"). In fact the server already holds the rotation: the new code
  is in effect and the old one is not. The fuzzer hit this 12 times in 16 retries.
- **M3RR-2 (medium, from the M3R-15 fix).** No 429 or 503 with Retry-After counts as a failure any more. M4 answers every
  overload with `503 retry_after 5`, so during a sustained outage each client retries every ~10 s, forever: 364 rounds in an
  hour instead of about a dozen.
- **M3RR-3 (medium, design owner, from the M3R-1 fix).** The outbox question the implementer raised. After a torn slot, the
  acknowledged save held in the outbox is gone from every device. It survives only in a rolling snapshot, which no automatic
  path reads and which ages out after ten more saves. The old code kept it, by accident.

Eight lows (M3RR-4 to M3RR-10, M3RR-13) and a test gap (M3RR-11) complete the list:
- M3R-1's order is untested in `push()` and in `commitRotation`;
- M3R-9's undo is untested for a 5xx and for a landed join;
- one of the lows is a bug from the first patch that neither review saw: a restarted worker resets the stored server offset
  to 0 (M3RR-9);
- one is a protocol residual the long model found: a request delivered late, after an honest PITR, is accepted by the
  version-only CAS (M3RR-13).

---

## 0. Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean (revision-17 tree and revision-18 tree) |
| `vitest run`, revision-17 tree | **98 files, 1,534 passed, 1 skipped**: reproduces the claim |
| `vitest run`, revision-18 tree (current main + patch) | 97 files passed; the one failure is the 8 MiB D3 test (`m3-scenarios`) timing out at 180 s under a load average of ~270 (another agent's suite and my mutants ran at the same time). Run alone it passes (127 s), so the revision-18 tree is green. Note: the D3 test's 180 s budget is fragile on a loaded machine |
| `npm run build` + `check-dist` | OK. Popup **53.8 KB** gz (budget 60). The built `dist/` (35 files) is **byte-identical** to main's `dist/` (SHA-1 of every file). The only `sk_sync_*` string in the bundle is M2's key table (`sw.js`, an errors chunk), which main already has |
| e2e (Playwright, 1 worker) | **99/99**: 98 passed in the run. `regression/ui-misc.spec.ts` ("a clock that jumps 31 days ahead…") timed out under load and passed alone (3.7 s). The patch changes nothing bundled |
| contract: `test_contract.py` | 40/40 (revision 17); **42/42** (revision 18) |
| contract: `check_consistency.py` | 0 hard mismatches (both trees) |
| M4's own suite (`api/server`, separate copy, its own Postgres on TCP 55497) | **469 passed** |
| my probes (`m3rr-probes.test.ts`) | 14 tests: **11 fail** on the patch (the confirmed findings below); 3 pass, all of them sanity controls (two contexts recovering at once, both slots torn, a tear between the state read and the PUT) |
| my rotation fuzzer (4 devices, clocks 0/+2 d/−2 d/+3 h) | **40 × 60, seed 777: no data loss, every PUT and rotate absorbed the head it replaced, no write that no key opened**. 71 rotations, 7 `not_synced`, 17 `unconfirmed`, 16 retries, 12 of them `not_synced` while the server's key had already moved (M3RR-1) |
| the model, long (`m3-model`, new seeds) | **Pass 1:** 3 devices, 150 × 80, seed 31337: **149/150**. Run 150 (seed 1041502085) failed only `watchServer`'s "absorb the replaced head" check: a late request after a PITR (M3RR-13); its convergence and oracle checks passed. The tear/hook/pw families (4 devices, 80 × 70, seed 4711): green. **Pass 2:** 3 devices, 200 × 80, seed 99991: green; families 80 × 80, seed 2027: green |
| my mutants (26, run as the implementer's are: tsc, the 16 M3 files with `--bail 1`, then the whole suite) | **13 killed, 1 equivalent, 2 near-equivalent, 10 survivors** (§4). Four survivors (MY-01, MY-04, MY-07, MY-08a) and the equivalent MY-02 "died" in the whole-suite run only from the D3 load timeout, after D3 had passed in their own M3 phase. The other six survivors passed the whole suite outright |
| the implementer's 99 mutants | the kill detail of every one re-read. MR-26 is killed by a 30 s hang, a legitimate kill (an infinite retry). MR-15 is equivalent, as claimed. N-01's first killer is the pinned read order in `m3-read-budget`, which is legitimate because the order is the fix |

---

## 1. Findings, confirmed

"Blocks merge" means it must be fixed before this patch lands. "Blocks M5" means M5 must not wire the engine into a shipping
build before it is fixed.

### M3RR-1 (medium): a lost rotation answer, retried, is reported `not_synced` while the rotation is in effect

- **Where:** `keys.ts:263-316` (`commitRotation`).
  - Every pass compares the fresh status with lastSynced (`:290`). If they differ, it calls `mergeFirst` (`:273-275`), whose
    round must come back `ok`; otherwise it throws `not_synced`.
  - Nothing first checks whether the server's keys already moved to this very rotation.
  - The rotation also records no pending fingerprint of its new code. `commitRecoveryCode` does (`setPending`, `:212`), so
    after an `unconfirmed` no round can ever say "in effect" for a rotation.
- **Failing sequence (probe RR-A):**
  1. `prepareRotation`.
  2. `commitRotation`: POST /v1/keys/rotate lands but its answer is lost, and the reconciling GET /v1/keys fails →
     `unconfirmed`.
  3. The server now holds VK2, and the new code opens its bundle.
  4. `commitRotation(h)` again: the status (v+1, the new head) differs from lastSynced, so `mergeFirst` runs. The round answers
     `needs_password` (the server is on VK2), and the call ends in **`not_synced`**.
  - Measured: `{"first":"unconfirmed","rotatedOnServer":true,"newCodeOpensServer":true,"retry":"not_synced","round":"needs_password","pending":null}`.
  - The fuzzer hit the same thing 12 times. Some of those were another device's rotation, for which the right answer is
    `changed_elsewhere` (the shown code is invalid), not "retry later".
- **Why it matters (A4, §0.0i item 14, §3.6.0):**
  - M3-NOTES §1.2 and §3 item 22 define `not_synced` as "nothing was sent, the code shown is not invalid, the same prepared
    rotation can be retried". All three are false here.
  - The old recovery code no longer opens the server's bundle. A user who keeps the old code and discards the new one, as
    "the rotation did not happen" suggests, has lost the only working recovery code; then a forgotten password locks them out.
  - `unconfirmed`'s own promise ("a later round tells", `keys.ts:42`) does not hold for rotations: there is no pending record.
- **Regression:** yes, from the M3R-2 fix. Plausibly the old code reconciled this case: its retry reached `sendKeyOp` and got
  `keys_conflict` first (A7), and the reconciliation then saw VK2.
- **Fix:**
  1. In each pass, before `mergeFirst`: if `s.vk_id !== p.vk1.id || s.kver !== p.server.kver`, run the reconciliation
     (`GET /v1/keys` plus `reconcileKeyOp({kind: "rotate", bundle: sealed.bundle}, {bundle, vkId: s.vk_id})`).
     - In effect: `rotations.delete(h)` and `commitPublished`.
     - Not in effect: `changed_elsewhere` (the code is void).
  2. Call `setPending(e, sealed.bundle, p.server)` before the first send, and `clearPending` on a known outcome. Then the round
     that follows the user's adoption says `recovery_in_effect`, and M3R-7's rule decides a rotation that never landed.
  3. Add RR-A as a regression test, and a "retried after unconfirmed" step in the fuzzer or the model.
- **Blocks merge:** yes. **Blocks M5:** yes.

### M3RR-2 (medium): M3R-15's fix turns a sustained 503 into a fixed ~10 s retry loop

- **Where:** `engine.ts:242-243`. `told` (any 429 or 503 that carries Retry-After) means `count = false`, so `failures`
  never grows and the backoff stays at `max(backoffMs(1) ≈ 10 s ± 20 %, Retry-After)`.
- **M4's overload answers:** `503 unavailable` with `retry_after = 5` for pool exhaustion, a slow body, a large-body slot
  wait and an unreachable auth provider (`db.py:72`, `pipeline.py:305`, `:312`, `:467`).
- **Failing sequence (probe RR-G):** the status answered `503 unavailable, Retry-After 5` for an hour of virtual time, with
  each `wake("retry")` run at its backoff → **364 rounds**, `failures` 0, the last gap 8 s.
  - Before the fix the same hour cost about a dozen tries (exponential to 30 min).
- **Effect:** during an outage every client polls the overloaded server about 6 times a minute, and an uploading client sends
  its envelope each time. It is an outage amplifier, not a data issue.
- **Provenance:** the implementer applied the first review's own suggested fix for M3R-15 (M3-REVIEW: "does not increment
  `failures`"). The regression comes from that suggestion, not from the implementation.
- **Fix:** count every 503, with Retry-After as a floor (`retryAt` already takes the max). For 429, keep the M3R-15 intent:
  - don't count an **explicit** round that runs inside a backoff that is still running; or
  - don't count a 429 but take `max(Retry-After, backoffMs(failures + 1))`.

  Add RR-G as a test.
- **Blocks merge:** no. **Blocks M5:** yes (M5 ships the network).

### M3RR-3 (medium, design owner): D1 now deletes an acknowledged save that only the outbox still holds

- **Where:**
  - `sync/local/state.ts:37-66`: `clearingItems`/`clearLastSynced`, the store's `beforeRecoveryWrite`, clears the outbox
    together with lastSynced.
  - `store.ts:275`: the hook runs before the pointer moves to the older slot.
  - `engine.ts:342-351`: since M3R-1, the locked round reads the state after that.
- **Failing sequence (probe RR-E):**
  1. Two devices in sync.
  2. A saves "saved, in the outbox"; the outbox is written.
  3. A locks ("lock every time", popup closed).
  4. A's active slot is torn.
  5. The worker restarts and rounds: `locked`, `pushedOutbox: false`, the outbox gone.
  6. Unlock and quiesce: the save is **on no device and not in the head**. It is only in a rolling snapshot.
  - Measured: `{"round":"locked","pushed":false,"onAnyDevice":false,"inHead":false,"inRollingSnapshot":true}`.
  - The user is told only "data restored automatically" (`slot_fallback`).
- **Assessment against "never lose data":** not acceptable as the final rule.
  - The copy that could restore the save is deleted by the engine's own hook. The remaining copies are reached by no
    automatic path:
    - `recover()` with one good slot never reads snapshots or the mirror (`store.ts:249-283`);
    - the rolling snapshot ages out after 10 more saves;
    - the mirror's copy is overwritten by the next commit (`store.ts:558`).
  - The rolling snapshot can also be missing altogether: its write is guarded, and a failure is only logged (`store.ts:553`).
    Then nothing but the outbox and the mirror ever held the save (plausible, not reproduced).
  - Pushing that outbox is safe:
    - it was built on (base, head) and is pushed only while the server is still exactly there (§4.7, D5);
    - `pushed()` cannot bring lastSynced back (D2: lastSynced is null after the hook);
    - the next full round pulls the pushed head and merges it into the recovered generation.

    So the old behaviour (R1b) was the right outcome, reached by accident.
  - The same loss happens in an **unlocked** round after a tear, before and after the fix: a full round never consults the
    outbox. With the outbox wired (M5), that save is recoverable too.
- **Safest rule (proposed for §4.1 D1):**
  1. The hook clears lastSynced but keeps the outbox, or moves it aside as `orphan`.
  2. The locked round pushes it only under the (base, head) CAS. A 409 or any other head drops it.
  3. A full round with the key opens an orphaned outbox (current VK, vault id checked, guard applied) and merges it as a
     second remote before deciding the upload. It is this device's own committed state.
  4. Optionally, at the store level: when the active slot is torn, prefer a rolling snapshot with the same keyring and a
     higher `seq` than the other slot.
- **Blocks merge:** no (the code follows D1 as written, and the tear is the store's). **Blocks M5:** yes. Decide it and
  implement it before M5 wires the outbox (P10, "lock every time"), which is what makes this reachable.

### M3RR-4 (low): the rotation's base read can be split by a round in another context (key operations take no sixkey-sync)

- **Where:** `keys.ts:277-296`. `current()` at `:279`, then `state.read()` at `:285`, with nothing held. M3-NOTES §3 item 12
  says key operations do not take the sync lock.
- **Failing sequence (probe RR-C):**
  1. A prepares a rotation; B writes Y and rounds.
  2. A's `commitRotation` loads its vault, without Y.
  3. Before the state read, A's worker context rounds: it pulls Y, merges it and sets lastSynced = (v+1, B's head).
  4. `commitRotation` then sees the server at lastSynced and rotates the vault it loaded at step 2, which lacks Y.
  - `watchServer` flags the rotate: 1 problem; the head under VK2 is `["GitHub"]`.
  - A's next round restores Y (`["GitHub","Y by B"]`): the merged data is in A's storage and `commitKeys` re-keyed it.
  - Not a permanent loss, but the "never replace a head you have not merged" invariant is broken for one round, and B sits in
    `needs_password` meanwhile.
- **Fix:** run the loop body (load, state read, status, send) under `e.deps.syncLock`, as a round does; a `busy` answer means
  try again. Or re-read `generation()` after the state read and start the pass again if its checksum changed.
- **Blocks merge:** no. **Blocks M5:** no.

### M3RR-5 (low): the kill switch is not checked when a new recovery code is sent

- **Where:** `keys.ts:205-214`. `commitRecoveryCode` sends PUT /v1/keys without a status query. Only
  `prepareRecoveryCode`'s `context()` was gated, and the user may spend minutes between the two.
- **Failing sequence (probe RR-B):** `prepareRecoveryCode`; the server raises `min_client_version` to 99.0;
  `commitRecoveryCode` → `ok`, with 1 accepted key write.
  - `commitRotation` re-checks in its loop (`:289`), but no test covers that check (MY-07 survives, §4).
- **Fix:** `await versionGate(e, p.c.signer)` before `setPending`. Add RR-B, and a commit-time case for the rotation.
- **Blocks merge:** no. **Blocks M5:** no.

### M3RR-6 (low): M3R-7's ten minutes run on this machine's clock and start before the first send

- **Where:**
  - `keys.ts:159-162`: `at = e.deps.now()`, written before the first attempt.
  - `sendKeyOp` (`:115-139`) re-signs each of its 3 tries later.
  - `engine.ts:637`: `this.d.now() - p.at > UNDECIDED_MS`, uncorrected.
- **Failing sequence (probe RR-F):**
  1. `commitRecoveryCode` with each PUT queued in the network (`late`) → `unconfirmed`.
  2. The machine's clock jumps 11 minutes (resume, NTP); the server's does not.
  3. A round says **`recovery_not_in_effect`**.
  4. The queued PUT arrives inside its signature window: the code **is** in effect.
  5. The next round adopts it (`keys_changed`) and says nothing more about the code.
  - Without a clock jump, the margin is 300 s minus the time between `at` and the last signature. With M5's timeouts unknown,
    three slow tries can eat it.
- **Fix:**
  - write `at` with `e.refNow()` and refresh it after each send attempt (or keep the last Sixkey-Ts), and compare on
    `this.refNow()`;
  - M5: a fetch timeout of at most 60 s.
- **Blocks merge:** no. **Blocks M5:** no.

### M3RR-7 (low): M3R-9's undo can leave an enrolled device row that no client holds

- **Where:** `enroll.ts:68-88` (`requireOff`). One `401 unknown_device` answer undoes the pending identity at once, though its
  last request may still be in flight and inside the ±300 s window.
- **Failing sequences (probe RR-D, both fail):**
  - (a) A recovery join's `complete` is queued (`late`) three times → `unconfirmed` → the round says `join_unfinished`. A new
    join undoes the identity. The queued `complete` then lands: the old device id is **enrolled on the server** with no local
    key (`{"devices":3,"oldEnrolledOnServer":true}`).
  - (b) A first upload whose init is queued: a second "turn sync on" undoes the identity. The init lands while the second one
    runs: the account's vault now has one device, which has no client. The second attempt gets `vault_exists`, and the
    profile is `off`.
- **Effect:** no data is lost; the user rejoins with the code. The device list shows a device that never syncs, and the user
  must revoke it.
- **Related (from the FakeServer pass, both servers alike):** after every `complete` failed on the network, the old recovery
  request stays open for 10 minutes. A new join in the **same account session** then gets `409 one_per_session`
  (`fake-server.ts:1203`, `enroll.py:317-323`). M3R-9's test passes only because `w.server.session()` makes a fresh session.
- **Fix:**
  - record when the identity last signed a request, and undo only once `unknown_device` is seen more than 2 × SIG_WINDOW
    later; otherwise report "join unfinished, try again in N minutes";
  - M6: use a fresh account session, or explain the 409.
- **Blocks merge:** no. **Blocks M5:** no (M6).

### M3RR-8 (low): M3R-9's way back is closed when the pending identity was revoked

- **Where:** `enroll.ts:79` takes only `401 unknown_device` as "no"; `403 device_revoked` is `"other"`, so `already_on`
  follows. The round says `join_unfinished` for a pending identity in both cases (`engine.ts:318-319`).
- **Failing sequence (probe RR-I):**
  1. The `complete` lands with its answer lost and both retries fail → `unconfirmed`.
  2. The owner sees an unknown "N" in the list and revokes it.
  3. N's round → `join_unfinished`; N's new join → **`already_on`**: the dead end M3R-9 was about.
  - M3-NOTES §10 item 14 says a new join works from `join_unfinished`.
- **Fix:** treat `403 device_revoked` like `unknown_device` for a *pending* identity, which can never be used again; or
  document `removeSyncIdentity` for this case.
- **Blocks merge:** no. **Blocks M5:** no (M6).

### M3RR-9 (low; in the first patch too): a restarted worker resets the stored server offset to 0

- **Where:**
  - `engine.ts:229`: `guarded()` writes `serverOffsetMs = this.offset` whenever it differs from the stored value.
  - `engine.ts:358`: `this.offset` is seeded from storage only on attempt 0, after `prelude()`.
  - `push()` (`:154-162`) never seeds it.
  - A fresh engine is therefore at 0 when a round stops in the prelude (`identity_missing`, `damaged`, `wrong_origin`,
    `cloud_restore`), or when a `push()` stops anywhere before a response.
- **Failing sequence (probe RR-J):** B's clock is 2 days fast; its stored offset is −48 h. B locks; IndexedDB is wiped; the
  worker restarts and rounds → `identity_missing`, and **the stored offset is now 0**. `push()` does the same.
- **Effect** until a later round learns the offset again:
  - local edits stamp their HLC with the uncorrected clock (`applyRemote`/`mutate` read the stored offset): M3R-5's
    problem, back;
  - with "use the corrected time" on and an offset under an hour, the popup's TOTP codes lose the correction, so every code
    is wrong.
  - `identity_missing` after a wiped IndexedDB is the antidetect-browser case the design cares about.
- **Fix:**
  - seed `this.offset` from `sk_sync_state` at the start of `guarded()` (or `push()`/`roundInner` before `prelude()`);
  - write `serverOffsetMs` only when a server time was received in this run (a flag set in `onServerTime`).
- **Blocks merge:** no. **Blocks M5:** no.

### M3RR-10 (low): a persistent `403 write_denied` costs five full uploads per round, reported as `version_conflict`

- **Where:** `engine.ts:533` (M3R-14) turns `write_denied` into `conflict`, and `roundInner` retries a conflict up to 5
  times (`:356-368`).
- **Failing sequence (probe RR-K):** every PUT answered `403 write_denied` → one round sends **5** PUTs, then reports error
  `version_conflict`.
  - With an 8 MiB vault, that is 40 MiB per round.
  - On M4, failed envelope requests are never refunded from `device_envelope_bytes` (§5.5), so they also eat the device's
    budget for real uploads.
- **Fix:** after a `write_denied`, take another status. Restart only if `vk_id` or `kver` moved; otherwise stop with error
  `write_denied`.
- **Blocks merge:** no. **Blocks M5:** no.

### M3RR-11 (medium, tests): mutants in the fix code that the suite does not see

My mutants that survive the 16 M3 files are below; §4 has the table.
- MY-01, MY-04, MY-07 and MY-08a failed the whole-suite run only on the D3 load timeout, after D3 had passed in their own M3
  phase.
- MY-10, MY-11, MY-17, MY-19, MY-23 and MY-25 passed the whole suite outright.
- **MY-01: `push()` reads the state before `generation()`.** No test tears a slot before `push()`. M3R-1's order is tested only
  in `round()`. (The mutant's effect is the R1b push, which keeps the save; see M3RR-3.)
- **MY-04: `commitRotation` reads lastSynced before its vault load.** This is M3R-1 inside the rotation: after a tear, it
  would rotate the recovered older vault over the head. No test tears a slot before `commitRotation`.
- **MY-07: `commitRotation`'s in-loop `min_client_version` check removed.** The M3R-3 test stops at `prepareRotation`.
- **MY-08a: `watchServer` no longer checks `POST /v1/keys/rotate`.** The M3R-2 tests assert `watch.checked > 0`, which their
  PUTs satisfy, so nothing tests the watcher itself.
  - MY-08b (the watcher off *and* N-02) is killed by the M3R-2 head assertions. The fix is guarded, but the oracle the review
    asked for is not tested.
- **MY-10: M3R-9's undo for *any* API error on the status (a 503 deletes the identity of a join that landed).** Survives the
  whole suite.
- **MY-11: M3R-9's undo also for a pending identity the server knows (status 200).** It would delete the identity of a join
  that landed and enrol a second device. Survives the whole suite: nothing tests `requireOff` with a landed join.
- **MY-17: A17's 410 after an unknown `complete` taken as enrolled without the status query.** Survives: no test has the
  request voided (reject-all) after an unknown `complete`.
- **MY-19: the approver's `approve` step not gated (only `respond` is).** Survives: the M3R-3 test stops at
  `Approver.start`.
- **MY-23: `firstUpload` does not store the server offset (M3R-5).** Survives: N-07's test covers `commitJoin` only.
- **MY-25: the error-code check allows any text of up to 40 characters.** Survives: M3R-13's test code is longer than 40,
  so only the length is tested, not the character set.
- MY-18's kill (turn-off on any refusal) comes through the `unconfirmed` path. Nothing tests a wrong password in `turnSyncOff`.
- **Model gaps:**
  - the model's `tear` family tears only a device exactly in sync (`m3-model.ts:138`), so it can never see M3RR-3;
  - the model never rotates. The fuzzer covers rotations, but has no second context (M3RR-4).
- **Add:**
  - RR-A to RR-K as tests;
  - a tear before `push()` and before `commitRotation`;
  - in `requireOff`: a status 5xx, a landed join and a revoked one;
  - a voided request after an unknown `complete`;
  - commit-time kill-switch cases (`commitRecoveryCode`, `commitRotation`, `submitSas`);
  - `firstUpload`'s stored offset;
  - an error code with markup under 40 characters;
  - `watchServer` asserted on a rotate-only write;
  - a wrong password in `turnSyncOff`.
- **Blocks merge:** the RR-A test (with M3RR-1's fix) yes; the rest no. **Blocks M5:** no.

### M3RR-13 (low; found by the long model; a protocol residual, not a regression): a request delivered late, after an honest PITR that reused its `if_version`, is accepted over another head

- **Where:** the server's CAS on `PUT /v1/vault` (and rotate) is by `if_version` only, on both the FakeServer and M4. The
  write proof covers (vaultId, if_version, checksum), not the head. D5's head check is client-side only.
- **Failing sequence (model, 3 devices, seed 1041502085, 80 steps; replays deterministically in 0.7 s with
  `test/unit/m3rr-replay.test.ts`):**
  1. A's PUT at `if_version = 2` (built on A's own v2 head) is delivered late: the client gave up at once (`late`) and its
     next round uploaded normally.
  2. An honest PITR takes the server back to v1.
  3. B writes a new v2, with another head.
  4. 105 s after it was signed, still inside the ±300 s window, A's stale request reaches the server. Its `if_version`
     matches, it is **accepted**, and v3 lacks B's v2 entries.
  - `watchServer`: "did not absorb the head it replaced (version 3)".
  - In that run the final convergence and oracle checks passed: B and the others still held the data and merged it back. So
    the loss was transient.
  - The implementer's model (600 × 70) and mine (149 of 150 runs) do not usually reach it.
- **Fix (M4/M8, no client change):** a restore fence. After a PITR the server records the restore time and refuses every
  signature whose Sixkey-Ts predates it by less than the window. Answer `401 clock_skew`: the client re-signs and the engine
  decides again from the new status.
  - Alternatively a contract change: `if_head` in the PUT and rotate CAS, or the head inside the write proof.
  - Record the residual in §1.2 A5.
- **Blocks merge:** no. **Blocks M5:** no (M8's PITR procedure).

### M3RR-12 (info, docs)

- `M3-NOTES.md:543-587` repeats the M3-01 to M3-43 table after the mutation table, behind a stray `---|---|---|---|` row.
- M3-NOTES §1.2 and §3 item 22 (`not_synced` = "nothing sent") are false for a retried rotation (M3RR-1).
- §10 item 14 ("a new join from a join's `join_unfinished`") misses the revoked case (M3RR-8) and the same-session 409
  (M3RR-7).
- `fake-server.ts:153` says M4 accepts `charset=utf8`. M4 at revision 18 does not (FS-1).
- `rejectedCheckedAt` is written before the status query (`engine.ts:313`). A rejected device that is offline at its daily
  retry waits another day (explicit retry still works).
- **Blocks merge:** no. **Blocks M5:** no.

---

## 2. Plausible (not reproduced)

- **P-RR-1 (low):** in M3RR-3's scenario the rolling snapshot itself may be missing. Its write is guarded, and a failure only
  logs a diagnostics line (`store.ts:553`). The save is then only in the outbox, which the hook deletes, and in the mirror,
  until the next commit. A total loss of an acknowledged save.
  - Fix: M3RR-3's rule.
  - **Blocks merge:** no. **Blocks M5:** no (it goes with M3RR-3).
- **P-RR-2 (low):** the M3RR-1 sequence on a device that is the only one holding a recent write. If M6 tells the user
  "rotation not done", the user may also be led to retry `prepareRotation`. That rotation is refused `stale` once the device
  adopted VK2, so it leads nowhere, but the shown code question remains.
  - Fix: M3RR-1's.
  - **Blocks merge:** no (covered by M3RR-1). **Blocks M5:** no.
- **P-RR-3 (info):** MY-02 (the locked branch of `loaded()` reading the state before `generation()`) is equivalent:
  `current()` runs `store.load()`, and with it any recovery, before `requireVk` throws `locked`.
  - No fix needed.
  - **Blocks merge:** no. **Blocks M5:** no.

---

## 3. The attack list, by fix

### 3.1 M3R-1 (the vault before the state): holds; one design question (M3RR-3)

Every read of `sk_sync_state` and the outbox, checked against every vault load that can run the recovery:

| Path | Load that can recover | State read | Verdict |
|---|---|---|---|
| `round` → `loaded()` (`engine.ts:342-351`), every attempt | `current()` | after | sound |
| locked round | `current()` (load before `requireVk`), then `generation()` | after | sound (MY-02 equivalent) |
| `push()` (`:154-160`) | `generation()` | after | sound; **untested** (MY-01) |
| `prelude` `identity_missing` (`:263`) | `restoreSyncIdentity` | before | benign: only `maxSeenVersion`, a lower bound |
| `prelude` `cfg_missing` (`:282`) | `vaultStatus()` | none | sound |
| `stop()` memo (`:433`) | `generation()` | n/a | benign: the memo is about the head |
| `syncKeys` → `commitKeys` | the transact's `loadInner` | the next attempt reads again | sound (stale check, then restart) |
| `applyRemote` | the transact's `loadInner` | CAS afterwards | sound: the upload contains the head; the CAS fails, or succeeds truthfully from null |
| `unlockedKey` | none | — | sound |
| `start()` (`:192-201`) | `generation()` | before | benign: a schedule only |
| `commitRotation` (`keys.ts:279, 285`) | `current()` | after | sound; **untested** (MY-04); see M3RR-4 for another context's round |
| `adoptWithSecret` (`keys.ts:455, 470`) | `generation()` | after | sound (only `status` read) |
| `context()`, `Approver.checked`, `firstUpload`, `prepareJoin`/`commitJoin` | `current()` / `load()` / transact | none, or the transact's base check | sound (a recovery between prepare and commit is refused) |
| the outbox writer (afterCommit) | inside the lock, after `loadInner` | inside the lock | sound |

- **Two contexts at once:** RR-H (the popup recovers inside the worker round's load, then commits) and RR-H3 (a tear and the
  popup's recovery between the worker's state read and its PUT: the newer generation is uploaded and the CAS fails) both
  pass. Nothing is lost.
- **Rollback to an older snapshot:** RR-H2 (both slots torn: the snapshot restore inside the round's own load, then pull and
  merge) passes.
- **FIXa2:** a rolled-back key change calls the hook (`store.ts:275`); `commitKeys` had cleared lastSynced already
  (`pins.begin`). The key crash matrix covers it.
- **The locked round no longer pushes a cleared outbox:** confirmed (RR-E). That is the M3RR-3 question.

### 3.2 M3R-2 (the rotation's base): holds for data; the retry path regressed

- The base is lastSynced with both version and head (N-02 and N-03 killed). After a conflict, the merge has to come back `ok`
  (MR-31 and MY-06 killed). There are at most 3 merges per call, so no 409 loop. Every pass loads the vault again (MY-03
  killed).
- `watchServer` checks rotate, opening each head with its own key (`m3-check.ts:89`). The helper itself is untested (MY-08a).
- The fuzzer ran 71 rotations under interleavings: another device's write between prepare and commit, a 409 raised inside the
  rotate, a lost answer, a lost answer plus a lost GET /v1/keys, a merge that cannot pull, partitions and late PUTs. No data
  was lost, and no write failed to absorb the head it replaced.
- Lost response: reconciled by VK id through status and GET /v1/keys. The resend is the identical text while the server holds
  the base.
- **Broken:**
  - the retry after `unconfirmed` (M3RR-1);
  - a round of another context in the base read (M3RR-4).
- No other key flow, repair, adoption or join uploads an envelope. The rotation is the only path that replaces a head outside
  the round.
- **M3R-7's rule:** the server can have applied the code while the client says "not in effect", if the clock jumps or the
  tries run long (M3RR-6). The base check (same kver and MAC) is right; only the clock is wrong.

### 3.3 M3R-3 (the kill switch): sound design, one gap

- **M4 never enforces `min_client_version`.** It only reports it in the status (`vault.py:117`). No write checks it, and no
  unauthenticated endpoint carries it (`/healthz` is `{ok: true}`).
  - So the switch is advisory: a malicious or pre-M3 client ignores it.
  - That is acceptable. It is a safety stop for honest builds with a known bug, not an access control, and no client without
    it ever shipped sync.
  - Server enforcement would need a client-version header (a contract change). It is worth recording in §4.2 step 1.
- **Exempting revoke, turn-off, reject-all and single reject is safe.** These writes only take access away. None touches a
  vault, a bundle or a key, and turn-off's second half is local. Blocking them would block the emergency the switch is
  meant for.
- **Gaps:**
  - `commitRecoveryCode` (M3RR-5);
  - registrations (by design, item 20);
  - `update_required` returns before `pendingEnrollments` is written (`engine.ts:325` before `:328`), so the badge goes
    stale (M5).

### 3.4 M3R-9 (the undo from `join_unfinished`)

- It cannot destroy a key that is still needed while the server answers honestly. The identity it removes is unknown to the
  server, and the vault (under the cloud keyring after `commitJoin`) and `sk_prejoin` are kept. The same-vault merge then
  keeps everything (M3R-9's test).
- **Not handled:**
  - a request that lands after the undo (M3RR-7);
  - a revoked pending identity (M3RR-8);
  - the same-session 409 (M3RR-7);
  - a 5xx being taken as "unknown" is not reachable today, but nothing tests it (MY-10).

### 3.5 The other fixes

Each item below was re-read and probed, and no regression was found except where a finding is named.
- **M3R-4:** the daily retry by `rejectedCheckedAt` holds (MY-14 killed). Info in M3RR-12.
- **M3R-5:** the server offset is stored before the merge and at the join (N-07 and N-22 killed). It is undone by M3RR-9
  after a worker restart.
- **M3R-6:** a lost reveal is resent identically, only while the server says `responded`.
- **M3R-8:** turn-off is idempotent (MY-18 killed).
- **M3R-12:** `pendingEnrollments` holds (MY-15 killed).
- **M3R-13:** error-code capping holds (MY-25).
- **M3R-14:** the adoption order comes from the fetched bundle; `write_denied` becomes a conflict (MY-16 killed), but see
  M3RR-10.
- **M3R-15:** Retry-After is not counted as a failure (MY-12 killed). See M3RR-2.
- **P-1:** `committed_on_server`. For `commitRecoveryCode`, the pending record then stays, and the next round says
  `recovery_in_effect`.
- **P-2:** a pruned history version (404) is skipped (MY-13 killed). Skipping cannot jump over a v2 version that still
  exists, because a pruned version is gone.
- **P-3:** the unconfirmed follow-up of init holds.
- **A17:** a retried `complete` answered 410 is settled by a status signed as the new device (MY-17).
- **`server_time` 0:** ignored; the Date header is used instead.

---

## 4. Mutation testing (mine)

Runner: `scratchpad/m3rr-scripts/mut.py`. Each mutant runs on a fresh copy of the patched extension, without my probe files:
- the exact replacement;
- `tsc --noEmit`;
- the 16 M3 files with `--bail 1`;
- for a survivor, the whole suite.

Every mutant typechecks. The machine ran at a load average of ~270 (another agent's suite was running too). The 8 MiB D3
test then exceeds its 180 s budget in some whole-suite runs, so a mutant whose only whole-suite failure is that timeout,
after D3 passed in its own M3 phase, counts as a survivor.

| # | The bug (in the fix code) | Result | Killer / why it survives |
|---|---|---|---|
| MY-01 | `push()` reads the state before `generation()` (M3R-1 on the push path) | **survived** (M3 files) | no test tears a slot before `push()` |
| MY-02 | the locked branch of `loaded()` reads the state before `generation()` | equivalent | `current()` loads (and recovers) before `requireVk` throws `locked` |
| MY-03 | `commitRotation` loads the vault once, before its loop | killed | m3-review M3R-2 "another device writes between prepareRotation and commitRotation" |
| MY-04 | `commitRotation` reads lastSynced before its vault load | **survived** (M3 files) | no test tears a slot before `commitRotation` |
| MY-05 | `adoptWithSecret` not gated | killed | m3-review M3R-3 |
| MY-06 | the rotation's merging round may come back offline or error | killed | m3-review M3R-2 "a 409 whose merging round cannot pull" |
| MY-07 | `commitRotation`'s in-loop `min_client_version` check removed | **survived** (M3 files) | the M3R-3 test stops at `prepareRotation` |
| MY-08a | `watchServer` skips `POST /v1/keys/rotate` (test helper) | **survived** (M3 files) | `checked > 0` is satisfied by PUTs |
| MY-08b | the watcher's rotate check off **and** the rotation's base from the fresh status (N-02) | killed | the M3R-2 head assertions |
| MY-09 | `UNDECIDED_MS` of 30 s | killed | m3-review M3R-7 |
| MY-10 | M3R-9's undo for any API error on the status (a 5xx) | **survived** (whole suite) | no 5xx in `requireOff` |
| MY-11 | M3R-9's undo also for a landed join (status 200) | **survived** (whole suite) | no landed pending identity in `requireOff` |
| MY-12 | a 429/503 that is not counted also loses its Retry-After | killed | m3-faults "429 and 503 with Retry-After" |
| MY-13 | a pruned history version (404) ends the walk as unreadable | killed | m3-review P-2 |
| MY-14 | `rejectedCheckedAt` refreshed by every round that stops at the daily check | killed | m3-review M3R-4 |
| MY-15 | `pendingEnrollments` written on every status | killed | m3-read-budget (the steady state writes nothing) |
| MY-16 | a PUT's `403 write_denied` taken as a revocation | killed | m3-review M3R-14 |
| MY-17 | A17: a 410 after an unknown `complete` taken as enrolled without asking | **survived** (whole suite) | no voided request after an unknown `complete` |
| MY-18 | `turnSyncOff` finishes the local half on any refusal (a wrong password too) | killed | m3-review M3R-8, through the `unconfirmed` path (the wrong-password case itself is untested) |
| MY-19 | the approver's `approve` step not gated | **survived** (whole suite) | the M3R-3 test stops at `Approver.start` |
| MY-20 | `commitRotation` without its "the key changed meanwhile" check | survived, masked | the server's `keys_conflict` refuses it (`changed_elsewhere` instead of `stale`) |
| MY-21 | an unlocked round drops the outbox before it knows the outcome | killed | m3-faults "a timeout…: the outbox and the local edit are kept" |
| MY-22 | the 10-minute rule ignores whether the server still holds the base bundle | survived, near-equivalent | it decides *earlier* once the server left the base; a request with that `if_kver` can never land then (if anything, the mutant fixes a never-decided corner) |
| MY-23 | `firstUpload` does not store the server offset (M3R-5) | **survived** (whole suite) | N-07 covers `commitJoin` only |
| MY-24 | P-1: a stale commit after the server accepted reported as success | killed | m3-review P-1 |
| MY-25 | the error-code check allows any text of up to 40 characters | **survived** (whole suite) | M3R-13's test code is over 40 characters |

On the implementer's claim of "98/99 killed": it is true of their 99 mutants, and every kill I re-read is real. Their
mutants cover the mechanisms each fix names. They do not cover the fixes on their *other* paths (`push()` and
`commitRotation` for M3R-1, the commit step for M3R-3, the "landed" and 5xx branches for M3R-9), which is where my
survivors are.

---

## 5. The FakeServer against M4 and the contract (revisions 15–18)

Checked decision by decision against `api/openapi.yaml` and `api/server/sixkey_server`, with file and line on both sides, in a
separate pass. M4's suite: 469 passed.

**Aligned:**
- **A5:** shape and kver window, the idempotent 200, `keys_conflict`, the proof, vaultId/vkId/`by`, then P4.
- **A7:** the rotation's order.
- **PUT /v1/vault:** `version_conflict`, then `vk_mismatch`, then `write_denied`, then revoked; the cursor rule.
- **A11–A20.**
- **The account token:** an ES256 JWT (kid, `aud`/`role` = authenticated, iss, exp, iat skew, a UUID `sub` and
  `session_id`).
- **The order of the checks:** 413, Content-Type, the session, the signer headers, the row, the signature, revoked, the
  window, then the body.
- **The rest:** error codes and details, Retry-After as both header and body, the 413 for an envelope over 8 MiB, the body
  limits, init's idempotency, the `devices_rev` triggers, the history order, `min_client_version` "0.1.0".
- **`pending_enrollments`:** both count unexpired approval requests in state `pending` only, so the badge gets the same
  number from both.

No FakeServer-only assertion from the first review remains (m3-fake-server:464, :580, :593 and :612, and m3-edges:212-218,
now assert M4's answers).

**Remaining differences.** All are low; none touches an engine data path, and none blocks M5.

| ID | FakeServer | M4 / contract | Engine dependency |
|---|---|---|---|
| FS-1 Content-Type | accepts `charset=utf8`, quoted values, repeated parameters and spaces around `=` (`fake-server.ts:154-162`) | M4 and **revision 18's §5.4 text**: only `application/json` with optional `charset=utf-8` (`pipeline.py:269-279`) | none: `api.ts:118` sends exactly `application/json`. M5's transport must not rewrite it |
| FS-2 `last_seen_at` | written by every device-signed request (`fake-server.ts:602`) | only by GET /v1/sync/status (`vault.py:112-114`) | none |
| FS-3 respond/approve on a gone request with a wrong pw_auth | 410, not counted (`fake-server.ts:1091, 1120`) | 403 `password_mismatch`, counted (`enroll.py:135, 173`) | none: the Approver checks the password locally first |
| FS-4 registration key off the P-256 curve | 401 `bad_signature` | 422 `invalid_request` (`pipeline.py:388`) | none |
| FS-5 `\|` in the target | 422, before authentication | 401 `bad_signature`, after the body | none |
| FS-6 expired request with a bad signature | 410 before the signature | 401 `bad_signature`; expiry is judged in the handler | none |
| FS-7 a token of a deleted account | `session_invalid` | only the JWT is checked; GET /v1/account answers `has_vault: false` | none (no deletion flow) |
| FS-8 list order | insertion order | `ORDER BY created_at, id` | `Approver.list` passes the order through to M6 |
| FS-9 revocation re-checked inside writes | PUT /v1/vault and rotate only | every write transaction (`common.py:46-53`) | untested interleaving |
| FS-10 auth salt equal to the wrap salt | 422 | not checked | none (stricter, which is fine for an oracle) |
| D7 rate limits | not modelled | per device, account and session; recovery 5/h | M3RR-2 (Retry-After), P-4, long history walks |
| D9 retention | history kept whole | pruned in PUT, rotate and daily | P-2. `m3-check.ts:128` reads history (FakeServer-only by design) |

---

## 6. Sound (checked and holding)

- **M3R-1's fix on every path that loads the vault** (table in §3.1): two contexts, both slots torn, and a tear between the
  read and the PUT all hold.
- **M3R-2's fix for data:** the base, the head check, merge-first with `ok`, bounded retries, rotate in the watcher, and 71
  fuzzed rotations without loss.
- **The kill switch's design and exemptions.** It is client-side by necessity (M4 never enforces it).
- **The fixes for M3R-4, -5, -6, -8, -12, -13 and -14, and for P-1, P-2, P-3 and A17**, plus `server_time` 0. Each is killed
  by its tests under my mutants (§4), except where a finding is named.
- **The FakeServer as an oracle** for every engine data path (§5).
- **Hygiene:** popup isolation (dist byte-identical to main's), the source rules, the read budgets (MY-15 killed), secrets
  hygiene (the model's check).
- **The implementer's 99 mutants:** every kill is real, and MR-15 is equivalent.
- **The patch on revision 18:** it applies cleanly; typecheck, the suite (modulo the D3 load timeout) and contract checks
  pass (42/42, 0 hard mismatches).

---

## 7. Verdict

**MERGE AFTER FIXES.**

The two write-path fixes (M3R-1, M3R-2) are right, and nothing I tried loses data:
- every recovery path;
- two contexts at once;
- 71 fuzzed rotations;
- the long model (510 runs of 70–80 steps; its one failure is the PITR residual M3RR-13, transient and not a regression).

Three of the fixes introduced regressions. One of them is on the key path and breaks the A4 rule the milestone exists to
keep.

**Must be done before merge:**
- M3RR-1: reconcile before `mergeFirst`, and a pending fingerprint for the rotation's code, with RR-A as a test.

**Should be done with it (cheap), and must be done before M5 ships the network:**
- M3RR-2 (count 503s);
- M3RR-3 (the design owner's D1 decision, then the outbox rule);
- the tests of M3RR-11.

**The rest are low:** M3RR-4 to M3RR-10, and M3RR-13 (for M4/M8's PITR procedure).

**Counts:**

| Severity | Confirmed | Plausible |
|---|---|---|
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 4 (M3RR-1, M3RR-2, M3RR-3, M3RR-11) | 0 |
| Low | 8 (M3RR-4 to M3RR-10, M3RR-13) | 2 (P-RR-1, P-RR-2) |
| Info | 1 group (M3RR-12) and FS-1 to FS-10 | 1 (P-RR-3, an equivalent mutant) |

**Top three:**
1. **M3RR-1:** a retried rotation whose first answer was lost says "nothing was sent, the code is not invalid" while the
   rotation, and its new code, are already in effect on the server.
2. **M3RR-2:** M4's `503 retry_after 5` now never backs off, so every client retries every ~10 s through an outage.
3. **M3RR-3:** after a torn slot, D1's hook deletes the outbox that is the last live copy of an acknowledged save; the save
   survives only in a snapshot no automatic path reads.

## 8. Corrections to the M5 hand-off (M3-NOTES §10)

1. **Preconditions.** Add M3RR-1 (merged) and M3RR-2. M3RR-3 must be decided and implemented before the outbox writer is
   wired (item 2), because P10 is exactly the "lock every time" case M3RR-3 loses.
2. **Item 3 (EngineDeps).** Key operations that upload an envelope (`commitRotation`) should hold `syncLock` like a round
   (M3RR-4). M5's settings page runs them while the worker's alarms run rounds.
3. **Item 4 (the transport).** Add:
   - a fetch timeout of at most 60 s (M3R-7's margin, M3RR-6);
   - no automatic retries inside the transport: the engine's idempotency and reconciliation assume one delivery per call,
     and a transport retry is a "late" duplicate;
   - send exactly `Content-Type: application/json` (revision 18, §0.0r item 4);
   - lower-case header names; pages' requests via the worker never take `sixkey-sync` (already listed).
4. **Item 6 (the popup).** `totpOffset`/`clockNotice` are still in `core/sync/engine/clock.ts`, so the move stands. The
   popup's corrected TOTP reads `sk_sync_state.serverOffsetMs`, which M3RR-9 can reset: fix M3RR-9 before shipping the
   correction switch.
5. **Item 7 (the badge).**
   - `view().state.pendingEnrollments` is right.
   - Also clear the badge when sync is off: `sk_sync_state` goes with it, so the value reads 0.
   - Clear or freeze it on `update_required` and `rejected_by_server`: the status code returns before the count is written.
6. **Item 8 (configuration).**
   - `manifest.base.json:5` and `package.json:3` are 0.0.1; M4's default minimum is 0.1.0 (`config.py:74, :115`), and the
     test devices and the FakeServer already use 0.1.0. Bump the manifest to at least 0.1.0 in the same change that ships
     sync. A check-dist assertion of `manifest.version >= the documented minimum` would stop a regression.
   - `api.signIn`/`sessionFromToken` exist (`api.ts:29-41, 182-185`). Keep the session in page memory only.
7. **Item 10 (e2e against M4).** Add:
   - a lost rotation answer, then the same handle retried (M3RR-1);
   - a sustained `503 retry_after 5` (M3RR-2: the backoff must grow);
   - the outbox plus a torn slot in "lock every time", after the D1 decision (M3RR-3);
   - the kill switch raised between `prepareRecoveryCode` and `commitRecoveryCode` (M3RR-5);
   - a worker restart in `identity_missing` keeping the offset (M3RR-9).
8. **Item 14 (M6).**
   - A new join from `join_unfinished` needs a fresh account session within the request's 10 minutes (`409
     one_per_session`), and fails for a revoked pending identity (M3RR-7, M3RR-8).
   - `not_synced` from `commitRotation` must not be shown as "nothing happened" until M3RR-1 is fixed.
   - `write_denied` must not be displayed as a version conflict (M3RR-10).
9. **For M8 (not M5):** the PITR procedure needs a restore fence: refuse signatures from before the restore (M3RR-13). Until
   then, a request in flight across a PITR can replace a head it never saw.
