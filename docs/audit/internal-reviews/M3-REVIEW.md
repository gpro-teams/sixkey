# M3 review: the sync engine and the in-memory FakeServer

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: repository paths
> updated to the current layout and absolute local paths shortened, and the rows this session left as TODO marked as
> unfinished (see below). Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants,
> logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted
> into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

Date: 2026-10-17. Reviewed: `scratchpad/m3/M3.patch` (35 files, 8,506 lines) applied with `patch -p1` to a fresh rsync of
the repository in `scratchpad/m3-review/` (`node_modules` symlinked). Spec: SYNC-DESIGN rev. 14 (§0.0e–§0.0n, §2.5, §3,
§4, §8.2/§8.3, §9 M3 row, §10, §13), M2-NOTES §7 with M2-REREVIEW's corrections, api/openapi.yaml, contract/vectors, and
the real M4 server (api/server: read for every endpoint, and run in a separate copy with its own Postgres cluster).
M3-NOTES was read after the first probes, to separate known gaps from new findings.

**SYNC-DESIGN revision 15 (§0.0o, the M4 backend) landed in the main tree during this review (18:38).** It adopts M4's
behaviour as the design for the points in §4 marked "rev. 15":
- A5, A7: CAS before proofs, and the rotate order;
- A13: `expires_at` rounded up to the minute;
- A14: reject-all covers recovery requests, with a timestamp bound;
- A15: identical respond/reveal retries answered 200;
- A16, A17: `complete` retried → 410, a taken device id → 409.
Where the FakeServer differs on those, it now deviates from the design. My findings were checked against rev. 14 and
re-read against rev. 15: none changes, and M3R-6's and M3R-9's fixes become more clearly right.

Every finding marked **confirmed** has a probe that fails on the patch as submitted. All of them are in the scratch copy:
`extension/test/unit/m3r-probes.test.ts`, `m3r-probes2.test.ts` and `extension/test/review/m3r-model.test.ts`. The fix
prototypes are in `scratchpad/m3r-fix/`, and my mutants, logs and results are in `scratchpad/m3r-scripts/` and
`scratchpad/m3r-logs/`. Nothing in the main tree was changed except this file.

**In one paragraph.** The engine is carefully built and mostly right. The D2 outbox CAS, needPull by (version, head),
the clamp-then-compare-with-raw rule, the R6 stop, the guard on all three merge paths, the stale-capability handling
and the RR-12 first upload all hold under my attacks. Two write-path bugs do not:
- **M3R-1 (critical).** A round reads lastSynced before the vault load that can run the storage recovery. After a torn
  slot, it uploads the recovered, older local state over the head without a merge. Accounts that only this device and
  the server held vanish from every device. They survive only in the server's history and local snapshots.
- **M3R-2 (high).** The key rotation takes `if_version` from a fresh status query but uploads the unmerged local vault.
  Another device's write made between "prepare" and "commit" is replaced on the server, and comes back only once that
  device types its password.

Both have small fixes, which I prototyped and checked against the whole M3 suite and an extended model. The FakeServer
differs from M4 in ten ways that matter to the engine (§4). None of them hides a data-loss bug, but two are deployment
blockers for M5 (min_client_version, the JWT `sub`).

---

## 0. Verification in the review copy

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run` (whole suite) | 97 files, 1,474 passed, 1 skipped (the existing `sync-crypto-adversary` skip): reproduces the claim |
| contract: `check_consistency.py` | 0 hard mismatches |
| contract: `contract/py/test_contract.py` | 31/31 |
| contract: TS `contract-openapi`, `contract-vectors` | green (part of the suite) |
| build + check-dist, e2e | not run in this session (the row was left unfinished). The implementer's runs on each later revision are in `docs/design/notes/M3-NOTES.md` §5.3 |
| the engine against the real M4 server | 11 scenarios (a–k) + 12 edge cases on both backends: all converge on M4; 6 behaviour differences (§4.1) |
| my probes (`m3r-probes*.test.ts`) | 15 probes, 12 fail on the patch (the confirmed findings below); the 3 that pass are a control (popup first), the R1b observation and the 2-days-slow case |
| my model (`test/review/m3r-model.test.ts`, 4 devices, new families) | with storage tears: fails on the first run (M3R-1); without tears: 150 runs × 70 steps green; on the fix copy, with every family: 60 × 60 green |
| my mutants | not finished in this session (31 written, MR-01 to MR-31). The implementer ran all 31 on the reviewed patch for revision 2: `docs/design/notes/M3-NOTES.md` §7 |

---

## 1. Findings, confirmed

Severity is about consequences for the user's data and keys. "Blocks merge" means it must be fixed before this patch
lands. "Blocks M5" means M5 must not wire the engine into a shipping build before it is fixed.

### M3R-1 (critical): after a storage recovery inside the round's own load, the older local state is uploaded without a merge

- **Where:** `engine.ts:322-332` (`roundInner`).
  - `const view = await this.state.read()` (lastSynced, the outbox) runs first.
  - Then `cur = await this.d.flows.current()`.
  - Then attempt 0 uses that `view`: `attempt === 0 ? view : await this.state.read()`.
  - `flows.current()` is `store.load()`. When the active slot is unreadable, that call is `recover()`, which runs the
    `beforeRecoveryWrite` hook (clearing lastSynced and the outbox, D1) and then switches the pointer to the older
    generation (`store.ts:189-205, 244-280`).
  - The round has already read the pre-recovery lastSynced. It therefore computes `needPull = false` (the server is
    still at lastSynced) and `dirty = true` (the recovered checksum differs), and takes the "dirty only, upload as is"
    branch (`engine.ts:403-404, 413-417, 468, 473-488`) with the older vault. The CAS that follows fails (lastSynced is
    null now), but the PUT has already been accepted.
- **Failing sequence (probe R1, `m3r-probes.test.ts` and `m3r-probes2.test.ts`):**
  1. Three devices in sync.
  2. A adds X; A's round uploads it (lastSynced names A's generation with X); B and C have not pulled yet.
  3. A's active slot is torn (`tear()`, the damage the two-slot store exists for); the other slot holds the generation
     before X.
  4. The service worker restarts and wakes on its alarm: `engine.round()` with nothing having opened the vault in that
     context.
  5. The round is `ok` and uploads once: the head no longer has X.
  6. After `quiesce`, X is on no device and not in the head; it survives only in server history v2 (and A's rolling
     snapshot).
  - Control: the same with the popup opened first (`svc.status()` recovers before the round) keeps X.
  - Measured: `{"round":"ok","head":["AWS","GitHub"],"a":…,"b":…,"c":["AWS","GitHub"],"xInHistory":[2]}`.
- **Likelihood in production:**
  - The service worker runs `store.selfCheck()` at browser start and install (`background/sw.ts:18, 35-36`). Damage
    present at startup is therefore recovered (and lastSynced cleared) before any round.
  - The window is damage that appears while the browser runs (a LevelDB block found corrupt on read, a vendor's
    profile sync replacing storage under a running profile), with the next vault load being a worker round (an alarm,
    the popup closed), not the popup's open and not the daily routine.
  - That is narrower than my probe, but it is exactly the case §4.1 D1 calls a mechanism rather than a convention.
    The consequence (synced accounts silently gone from every device, the user told only "data restored
    automatically") is the worst this engine can do, so I keep "critical". The fix is two swapped statements.
- **Why no test saw it:** the crash matrix's recovery scenario (`m3-crash-round.test.ts:81-107`) runs
  `c.svc.status()` before the round, which recovers in a separate load. In the model, nothing ever tears a slot.
- **Also (benign, same cause, R1b):** when locked, `lockedRound` gets the same pre-recovery `view` and pushes the outbox
  the hook just removed. That outbox holds data newer than the recovered local copy, so it does no harm, but it
  bypasses D1's mechanism.
- **Fix:** read the vault first, then the sync state, on every attempt. Swap the two blocks at `engine.ts:322-329`
  (attempt 0 then behaves like attempts 1-4, which already read the state after `current()`).
  - Why this is enough: a recovery's hook runs inside the vault lock before the pointer switch. If `cur` is the
    recovered generation, the state read after it sees `lastSynced = null`. If the recovery comes after the state read,
    `cur` is the pre-recovery, newer generation, which evolved from that lastSynced.
  - Prototyped in `scratchpad/m3r-fix/`: every R1 probe passes; the 15 M3 test files pass except one read-budget
    assertion that pins the old read order (`m3-read-budget.test.ts`, "the steady state": the same eight reads in a new
    order, so update the pinned list); the model with tears passes 60 × 60.
  - Add the probe as a regression test, and give the model a "tear after a synced round, then a worker round" step.
- **Blocks merge:** yes. **Blocks M5:** yes.

### M3R-2 (high): the rotation uploads the unmerged local vault with a fresh `if_version`

- **Where:** `keys.ts:244-266` (`commitRotation`). Each try:
  1. `s = await e.api.status()`;
  2. `cur = await flows.current()`;
  3. builds the rotation envelope from `cur.vault` at `rev: s.version + 1`, with `if_version: s.version` and a write
     proof over `s.version`.
  - Nothing ties `s.version` to what `cur.vault` has merged. The server's CAS, the very thing that should refuse a
    head this device has not seen, is satisfied by construction.
  - On `version_conflict` the code runs `e.round()` and sends again **whatever the round returned** (busy, offline,
    review_needed, error).
  - SYNC-DESIGN §3.8 P3: "version_conflict → 回到 P1 的合并步骤".
- **Failing sequences (probe R2):**
  - (a) A `prepareRotation` (its round is ok), the user reads the new code; meanwhile B adds Y and rounds (v+1).
    A `commitRotation`: the rotation is accepted at v+2, and the head (opened with VK2) lacks Y.
  - (b) The same race, but the hook makes B write inside A's rotate (409), and A's merging round cannot pull
    (`GET /v1/vault` fails). The rotation goes ahead anyway and the head lacks Z.
  - Consequence (`m3r-probes2.test.ts`): Y returns only when B is in `needs_password` and its user types the password
    (R3 merges B's local vault).
    - It is lost from the head until then, and for good if B never comes back: a profile the user retires, or the very
      device "revoke and protect" is about.
    - Measured: `{"afterRotate":["AWS","GitHub"],"bStatus":"needs_password","adopt":"adopted","headAfter":["AWS","GitHub","Y"]}`.
- **Why no test saw it:** `watchServer` (`m3-check.ts:42-47`) says it checks "Every PUT /v1/vault and rotate", but it
  matches only `PUT /v1/vault`. The rotation's envelope is under VK2, which the fixed `vk` cannot open either.
- **Fix:** base the rotation on what the local vault has merged (the same rule as the outbox).
  - Read `current()`, then lastSynced (the M3R-1 order).
  - With no lastSynced, run a round and require `ok`.
  - Use `if_version = lastSynced.version` and `rev = lastSynced.version + 1` for both the envelope and the write proof.
  - On `version_conflict`, retry only after a round that returned `ok`; otherwise fail with `not_synced`, and the shown
    code is not yet sent, so it is not invalid.
  - Prototyped in `m3r-fix/keys.ts`: both probes pass, as do `m3-keys`, `m3-crash-keys`, `m3-edges` and the rest of the
    M3 files.
  - Make `watchServer` check `POST /v1/keys/rotate` too, opening the replaced head with the old key and the new head
    with the new one.
- **Blocks merge:** yes. **Blocks M5:** yes (the rotation is reachable from any page that builds an engine).

### M3R-3 (medium): `update_required` stops the round only; key operations and enrolment still write

- **Where:** `engine.ts:311` is the only `min_client_version` check. `keys.ts` (`changePassword`,
  `commitRecoveryCode`, `repairKeys`, `revokeDevice`, `renameDevice`, `rejectAllRequests`, `clearServerHistory`,
  `turnSyncOff`, `adoptWithSecret`) and `enroll.ts` (`firstUpload`, both joins, `Approver`) never look at it.
  `commitRotation` even calls `status` and ignores the field.
- **Failing sequence (probe R10):**
  1. The server sets `minClientVersion = "99.0"`; A's round reports `update_required`.
  2. A then changes the password and commits a new recovery code: both `PUT /v1/keys` are accepted (2 key writes).
  - §4.2 step 1 says "低于 min_client_version → … 停止"; §8.3 says "停止读写". The kill switch exists to stop a build with
    a known bug from writing. Publishing bundles and approving devices are the writes that matter most.
- **Fix:** one gate in `keys.ts` `context()`/`preSend` and in `enroll.ts` before the first signed write. It is a
  status query (or the engine's last `status`, refreshed within a minute) checked with `versionBelow`, failing with
  `KeyOpError("update_required")` / `EnrollError("update_required")`. Emergency revoke stays allowed only if the design
  owner says so; the spec does not carve it out.
- **Blocks merge:** no. **Blocks M5:** yes.

### M3R-4 (low): the daily retry of a rejected identity never happens

- **Where:** `engine.ts:299` skips a `rejected_by_server` identity while `lastAttemptAt` is under a day old. But
  `guarded()` (`engine.ts:224`) refreshes `lastAttemptAt` on every round that stops there, at most every 30 s.
- **Failing sequence (probe R3):**
  1. A is revoked; its round marks it `rejected_by_server`.
  2. The server un-revokes it (an honest rollback).
  3. 96 wakes over two days, every 30 minutes: zero status queries.
  - §3.10: "每天重试一次状态查询". M3-NOTES §3 item 15 believes it works.
- **Fix:** a separate `rejectedCheckedAt`, written only when a status query is actually sent for a rejected identity;
  or skip the `lastAttemptAt` refresh when the round stopped before sending anything.
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-5 (low): the server offset learned during enrolment, and before the first merge, is not stored

- **Where:**
  - `applyRemote` clamps with the stored `serverOffsetMs` (`sync-flows.ts` via `a.refNow(sync)`), and so does every
    local edit's HLC.
  - The engine stores its fresh estimate only at the end of `guarded()` (`engine.ts:222`).
  - `firstUpload` and `commitJoin` never store it.
  - So on a device whose clock is off by days:
    - the first merge after joining clamps with the uncorrected clock;
    - an edit made between the join and the first completed round carries an uncorrected HLC.
- **Failing sequence (probe R5):**
  1. B joins with its clock 2 days fast and edits at once.
  2. Six rounds each: 3 accepted PUTs (`B:U A:U B:U`). §8.2 F5 bounds it at one upload per device.
  - Worse than the count: B's future stamp is clamped by the others to their `now + 24 h`, so for up to a day it beats
    real renames made elsewhere (LWW). Content only: deletes and erasures use their own registers.
- **Fix (prototyped; R5 passes):**
  - store the offset at the end of `commitJoin` and `firstUpload`;
  - store it in the round before `applyRemote` when it moved by the threshold (or pass the round's `refNow` into
    `applyRemote`).
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-6 (low): a reveal lost on the way stalls the approval until it expires

- **Where:** `enroll.ts:319-321` sends `reveal` once. If the request never arrives (`fail_before`), M1's machine is
  already `showing_sas`, and a poll that still says `responded` returns `wait` (`enroll-new-device.ts:144`).
  Nothing resends.
- **Failing sequence (probe R6):**
  1. The reveal fails before delivery.
  2. Five more polls on each side: the new device shows the SAS, the approver `wait`s forever (until the 10-minute
     expiry, 410).
  - M4 answers an identical reveal retry with 200 (§4, D13), so a resend is safe.
- **Fix:** keep the reveal body in `ApprovalJoin`. While the machine is `showing_sas` and the view is `responded`, send
  the identical body again (the same epk, nonce and name_ct: MUST 2 holds, the SAS is not recomputed).
- **Blocks merge:** no. **Blocks M5:** no (blocks M6's enrolment screens).

### M3R-7 (low): a new recovery code whose PUT never reached the server is never decided

- **Where:** `engine.ts:603` decides `pendingRecoveryWrap` only once the server's kver reaches the code's kver; and
  `syncKeys` runs only when the server's `(kver, vk_id)` changed. If the request was never delivered and nobody else
  changes the keys, neither happens.
- **Failing sequence (probe R9):** `commitRecoveryCode` with every `PUT /v1/keys` failing before delivery → `unconfirmed`;
  48 rounds over a day: no `recovery_in_effect` / `recovery_not_in_effect`, and the pending fingerprint stays.
  The user is left with "keep both codes" indefinitely. That is the safe direction, which is why this is low.
- **Fix:** when the server's bundle is still exactly the one the operation was built on (same kver and MAC, recorded
  with the pending fingerprint) and some minutes have passed, declare "not in effect".
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-8 (low): turning sync off is not idempotent after a lost revoke answer

- **Where:** `keys.ts:356-361`.
- **Failing sequence (probe R7):**
  1. The self-revoke lands and its answer is lost: `unconfirmed`.
  2. A second `turnSyncOff`: its pre-send `GET /v1/keys` is answered `403 device_revoked` and surfaces as a raw
     `ApiError`, not a `KeyOpError`. The profile stays "on".
  - A round then marks it `rejected_by_server`, and `removeSyncIdentity` finishes it, so the user is not stuck. The
    API contract of `turnSyncOff` is still broken.
- **Fix:** in `turnSyncOff`, treat `device_revoked` / `unknown_device` (on the pre-send or the revoke) as "already
  revoked" and run `turnOffSync()`. Map every `ApiError` in `context`/`preSend` to a `KeyOpError`.
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-9 (low): "join unfinished" has no way back through the enrolment API

- **Where:** `enroll.ts:67-72` (`requireOff`) and `enroll.ts:251`.
- **Failing sequence (probe R8):**
  1. A recovery-code join's `complete` gets 410; `commitJoin` returns `unconfirmed`.
  2. The round reports `join_unfinished`.
  3. Joining again is refused with `already_on`.
  - On M4 this is reached more easily than on the FakeServer: M4 answers a retried `complete` with 410 (§4 D6), and a
    `reject-all` on another device voids recovery joins (D8).
  - §3.5 says the user re-joins from this state and the same-vault merge keeps everything. Today M6 would have to call
    `removeSyncIdentity` first, which the API does not say.
- **Fix:** let `requireOff` accept a pending identity whose signed status is `unknown_device` (or have the round, on
  `join_unfinished` with `unknown_device`, offer exactly that). Document the path either way.
- **Blocks merge:** no. **Blocks M5:** no (M6).

### M3R-10 (low): `pinFirstUpload` writes the pin field `vaultId` through `identity.update`

- **Where:** `engine.ts:628` writes `vkId` and `vaultId` with `update()`. M2-NOTES §7 item 1 and §2.5 say the pin fields
  (`adopted`, `vaultId`, `maxSeenKver`) change only through `setPins`, which counts the write (`pinCount`, RR-4).
  `identity.update` documents the rule but does not enforce it (`identity.ts:123-135`).
- **Consequence:** none found: an unpinned first-upload identity has no pending copy to be ordered against. It is still
  a hole in the rule that RR-4 depends on.
- **Fix:** write `vaultId` (with `vkId`) through `setPins` and `maxSeenKver: 0`, `adopted` left null, or a dedicated
  `setReference()`. Make `update()` reject a change of `vaultId`, `maxSeenKver`, `adopted` or `pinCount`.
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-11 (medium, tests): the tests do not see six plausible bugs, two of them data loss

My mutants that survive the whole suite (§5.2; each is a one-line change, run as the implementer's are) mark what no test
checks:
- **MR-09 (F5's core): `needUpload` compared with the clamped remote instead of the raw one.**
  - It survives, but it is masked in practice. The engine clamps with its in-memory offset and `applyRemote` with the
    stored one; the two `refNow` values differ by milliseconds, so the mutant's comparison still differs and the clamped
    stamp is uploaded anyway. My end-to-end test (`m3r-probes` R11: a remote stamped 10 days ahead reaches the server
    clamped, and a real edit two days later wins on every device) passes with and without the mutant.
  - So: not a demonstrated loss. Keep the R11 test as F5's end-to-end regression; nothing covered it before (the F5
    test corrects every clock first, and the clamp test checks the local copy only).
  - Side note: two clamps with two `refNow`s in one round is accidental. M3R-5's fix (store the offset before
    `applyRemote`, or pass the round's `refNow`) makes them one.
- **MR-06: the engine skips `applyRemote` (and its guard) when the merge leaves the local vault unchanged.**
  - Effect: a remote that changed a secret but lost by HLC is overwritten on the server silently, with no review. I8 is
    the strongest tamper signal the guard has.
  - Add: a remote with another secret and an older stamp → `review_needed`. Written as `m3r-probes` R11: it passes on
    the patch and kills MR-06 (checked in the fix copy).
- **MR-02 / MR-04:** a locked push answered 409 acknowledged as pushed, and a lost push recognised by the version alone.
  - Both are made benign by `needPull`'s head comparison (the next round pulls), but they write a lastSynced the server
    does not hold.
  - Add: lastSynced after each of these equals the server's (version, head).
- **MR-11:** the `stuck` memo ignores the head, so a device stays paused after the head was repaired.
- **MR-12:** the rollback warning's maxSeenVersion is never lowered, so the warning repeats every round.
- **MR-14 (keys.ts decides on the unsettled identity).** After a key commit whose IndexedDB pin write failed, the next
  key operation is judged on pins behind the committed keyring. That is PROBE-15's `auth_without_password`, which
  refuses even a revoke. `m3-edges` PROBE-2 covers the engine's own settle only.
  - Add: the same fault, then `revokeDevice` and `changePassword` succeed.
- **MR-16 (A4's discipline): the "not decided yet" guard removed from `recoveryNotice` (`engine.ts:603`).**
  - Effect: a round in another context that runs between `setPending` and the PUT landing, **and** re-judges the keys
    then, says `recovery_not_in_effect`. The re-judging happens only when `keysSeen` changed, e.g. another device's
    key change, so the window is narrow. In that window the user may throw away a code that works, and the old one no
    longer does: the "从未显示/无效" window that §0.0i item 14 and §3.6.0 forbid.
  - Add: a round interleaved (a hold on `PUT /v1/keys`) says nothing until the server answers.
- **MR-20 (MUST 5):** after a lost `approve` answer, the CC shown without the confirming poll. No security loss (a
  payload that never landed cannot be used, and the server cannot forge one), but a MUST rule with no test. The live
  run's E12 shows the right behaviour; it is not in the suite.
- **MR-19:** `adoptWithSecret` accepts cfg_missing with a readable vault (an unfinished turn-off: RR-10 says never sign
  there). No test types a password in that state.
- MR-15 (no settle just before `commitPublished`'s commitKeys) survives too. It is probably equivalent: commitKeys
  lays the pending copy over the pins itself, inside the lock (`checkPins` with `pins.view`).
- Plus the two gaps behind M3R-1 and M3R-2 (the recovery scenario's `svc.status()` first; `watchServer` not covering
  rotate), and no probe for M3R-3 to M3R-9.
- **Blocks merge:** the MR-06 test yes (it guards the strongest tamper signal) and the M3R-1/M3R-2 gaps (covered by those findings); the rest no. **Blocks M5:** no.

*Unfinished in this session: the final survivor list was not written. The implementer's run of all 31 mutants on the
reviewed patch (16 survived; tests were added for them) is in `docs/design/notes/M3-NOTES.md` §7.*

### M3R-12 (low): the status poll's `pending_enrollments` is dropped

- **Where:** `api.ts:33,174` parses it; nothing stores or returns it (not in `EngineState`, not in `RoundResult`).
- **Effect:** §3.11 and §4.9's badge ("待批准数", locked too) has no source. M5 would need a second status request per
  poll, doubling the traffic §4.10 keeps small.
- **Fix:** store `pendingEnrollments` in `sk_sync_state`, written on change only (the read budget stays), in both
  `attempt` and `lockedRound`.
- **Blocks merge:** no. **Blocks M5:** yes (the badge is M5's).

### M3R-13 (info)

- `api.ts:125-126` keeps any string the server sends as `error.code`, and `guarded()` stores it in
  `sk_sync_state.lastErrorCode`. It is not secret, but it is untrusted, unbounded text in storage that M6 will display.
  Cap its length and character set (e.g. `/^[a-z_]{1,40}$/`, else `malformed_response`).
- `totpOffset` / `clockNotice` (S3) live in `core/sync/engine/clock.ts`, which the popup may not import (the source
  rule). The popup is where TOTP is shown: M5/M6 must move them to a popup-eligible module (e.g.
  `core/sync/local/clock.ts`) and extend the module list deliberately.
- The approval path joins against an empty cloud vault and cannot dedupe in the added mode (M3-NOTES §3 item 6): known
  and acceptable for M3. Only the design owner can choose among the three options. I prefer GET /v1/vault accepting
  `Sixkey-Enroll` once approved, which needs no payload change.

### M3R-14 (low): the unlock picks R4's order from the last round's stored status, and `write_denied` is not "the key moved"

- **Where:**
  - `keys.ts:415`: `needsPassword: view.state.status === "needs_password"`. A failed round after the rotation was seen
    (offline, an error) overwrites that status. The unlock then tries the local wrap first and, after a rotation with
    the same password, returns `local`: no adoption until the next round and the next unlock.
  - `engine.ts:505-512`: only 409 counts as a conflict. A `403 write_denied` (the server's write key moved under a
    rotation) is an error round with a backoff.
- **Evidence:** the live run (agent B, `m3-m4live/extension/test/live/m3-live-edges.test.ts` E4).
  - On the FakeServer, which checks the write proof before the CAS (as the openapi lists it), a PUT racing another
    device's rotation gets `write_denied`: the round errors, `adoptWithSecret` returns `local`, and the device does not
    adopt.
  - On M4, which checks the CAS first (`vault.py:166-171`, not recorded in M4-NOTES), the answer is 409 and everything
    works.
  - If M4 is ever aligned with the openapi text, the failure reaches production.
- **Fix:**
  - derive `needsPassword` from the bundle `adoptWithSecret` just fetched (`remote.keyring.vkId !== local.vkId`, or
    pinned ≠ local), not from stored status;
  - treat `403 write_denied` on PUT like `vk_mismatch` (restart: the status query tells `needs_password`).
- **Blocks merge:** no. **Blocks M5:** no.

### M3R-15 (low): repeated explicit rounds inside a 429 window push the backoff to its 30-minute cap

- **Where:** `engine.ts:229-244` counts every failed round; `schedule.ts:43-47` takes `max(backoff(n), Retry-After)`.
  An explicit "sync now" runs inside a backoff (`mayRun` explicit), so each press while rate-limited adds a failure.
- **Evidence:** live M4 (agent B, R1). 70 explicit rounds in a burst: the first 429 after 61 reads (60 per minute per
  device). Fifteen rounds failed `rate_limited`, and the backoff reached about 35 minutes for a 60-second limit.
- **Fix:** a 429 or 503 with Retry-After sets `backoffUntil` from Retry-After and does not increment `failures`; or
  explicit rounds inside a running backoff do not count.
- **Blocks merge:** no. **Blocks M5:** no.

---

## 2. Plausible (not reproduced)

- **P-1 (low): `changePassword` / `commitRecoveryCode` report `stale` after the server accepted.** `commitPublished`
  turns commitKeys' `stale` into `KeyOpError("stale")` ("start again") even though the server already holds the new
  wrap. No lockout follows: the next round reports `needs_new_password` (or adopts the recovery-only change). I found no
  honest interleaving that commits a different keyring locally between the pre-send check and the commit without also
  making the PUT fail with `keys_conflict`. It is still worth a distinct code (`committed_on_server`) so M6 never says
  "start again" for a change that took effect.
- **P-2 (low): the F6a walk fails the whole round on one missing version.** `remote.ts:53-63` lists the history and then
  fetches each version. M4 prunes history inside PUT and rotate (§4 D9), so a version pruned between the list and the
  fetch is a 404 that fails the round with a backoff. A persistent 404 makes `remote_unreadable` unreachable. Treat a
  404 as "skip it".
- **P-3 (low): `firstUpload` undoes its local half when the `vault_exists` follow-up status query fails on the
  network** (`enroll.ts:145`). If the init had landed, the server keeps a vault and a device row with no client; the
  user re-joins with the recovery code (nothing lost). Prefer `unconfirmed` there.
- **P-4 (low): the recovery join's three tries spend M4's recovery quota** (5 per hour per account and IP, not refunded,
  §4 D7). Each `fail_before` is free, but a lost answer is not: three lost answers and two typos exhaust the hour.

---

## 3. The attack list, area by area (what I tried, what held)

### 3.1 The round's write path (engine.ts, state.ts, the outbox)

- **Every await boundary between the decision and the CAS** (`engine.ts:400-488`).
  - A local commit after `cur`: applyRemote re-reads and re-merges in its transact, and the CAS (active checksum)
    fails, so the next round pulls the device's own upload and sends the edit.
  - A commit between the merge and the PUT: the same.
  - A recovery after `cur`: harmless, because `cur` is the newer state. A recovery inside `current()` is M3R-1.
  - Probed with server hooks inside the device's own PUT (an edit there, another context opening the popup, another
    device writing): `m3r-model` "hook" family, 150 × 70 green.
- **The CAS (`state.ts:158-171`)** compares lastSynced and the active checksum under the vault lock; the outbox writer
  runs under the same lock (afterCommit), so the two never interleave. Sound.
- **The outbox push (`engine.ts:518-549`, `state.ts:178-192`).**
  - It is pushed only while the server is at (base, head). lastSynced moves only from `from`, and only the same outbox
    is removed (D2, D5).
  - "A lost answer is (base+1, SHA-256 of the outbox text)": another device's write at the same version cannot have
    that head. The envelope carries a random IV, so only this text hashes to it. A malicious server that claims it has
    the text has accepted it, which is the same thing. Sound.
  - My mutants MR-02 and MR-04 show the head comparison in `needPull` would also repair a wrong lastSynced on the next
    round: defence in depth that is not tested (M3R-11).
- **Rollback detection.**
  - needPull by (version, head) catches every case: an equal-version replay with another head, a rollback of several
    versions (pull, merge, upload, no 409 loop), and an old head served under a higher version (a `rev_mismatch`
    notice, merged as data, then the merge result is uploaded).
  - The A5 warning fires once and resets `maxSeenVersion`. Sound.
- **paused_newer, R6.**
  - A v2 head stops the round. The walk stops at the first v2 version under the current key and never merges an older
    v1 one over the head. Nothing is uploaded while paused (MR-07 killed).
  - The locked round drops an outbox built on a version the v2 writer moved past. That differs from §0.0i item 15 R6's
    "outbox 保留", but such an outbox can never be pushed anyway (§4.7 "409 → 丢弃").
- **too_large and D7.**
  - A merge over 8 MiB is committed and only the upload paused; a merge past 50,000 entries is not committed.
  - The `stuck` memo is keyed on (head, version, local checksum, client), so it is not re-pulled every round, and a
    local deletion resumes it.
  - MR-11 shows its head key is untested.
- **The HLC and the server offset.**
  - The offset is clamped to ±7 days and taken at the exchange's midpoint. TOTP keeps the local clock unless the user
    chose the correction, and only within an hour. A signature retries once on `clock_skew` with `server_time`.
  - The first-round gap is M3R-5. F5's raw-remote comparison is right in code and untested (MR-09).
- **dirty** is by envelope checksum (I10 holds: a no-change mutate writes the same envelope; MR-11 of theirs killed).
- **The guard on every merge path.**
  - The round (engine pre-check plus applyRemote), the key adoption (commitKeys with the new key's data) and the rejoin
    (prepareJoin, same vault) all go through M2's `merged()`, which blocks on a changed secret or an erased live entry.
    A blocked merge writes nothing of the remote: only `maxSeenVersion` and a `rev_mismatch` notice may have been
    written before it.
  - The answer is bound to each blocking remote entry's SHA-256 and kept in memory. A new blocking entry, or a changed
    version of an answered one, blocks again. An answer cannot cover a version the user did not see.
  - The engine pre-check's `|| blocks(g)` matters (MR-06) and is untested.
  - Design residual, not a finding: the guard does not cover non-secret fields (issuer, label, digits, period,
    algorithm), so a VK holder can make every code wrong without a block (§4.4 "守卫只拦住一步到位的清除与改 secret";
    snapshots and history are the backstop).
- **Context races.**
  - Rounds in the service worker and the pages are serialized by `sixkey-sync`.
  - Key operations take no sync lock (M3-NOTES §3 item 12). commitKeys' stale check covers the local side; the
    server's CAS covers the rest, except where the engine defeats it (M3R-2).
- **The debounce.** `kickAt` and `dirtySince` are persisted, the 30 s alarm is the backstop, and `start()` re-derives
  dirty. A killed worker loses nothing (M3-33 of theirs, MR-28 of mine).

### 3.2 keys.ts

- **sendKeyOp (`keys.ts:96-120`).**
  - A lost answer, a 5xx or a `keys_conflict` is reconciled by the part this device changed (`reconcile.ts:17-30`):
    the recovery wrap's bytes, the password wrap (or a later bundle the new password opens), or the server's vk_id.
  - It resends the identical text only while the server still holds the base bundle (same kver and MAC), and otherwise
    reports `changed_elsewhere`.
  - Nothing is committed locally before an accepted or reconciled answer (M3-25 of theirs killed).
  - No sequence makes the user end with a code or password that opens nothing: a page that dies leaves the server
    first and the local half absent. The next round adopts (R2: same password wrap) or reports `needs_new_password`,
    and the typed secret then adopts.
- **Show before commit.**
  - `prepareRecoveryCode` and `prepareRotation` return the code before anything is sent.
  - The pending fingerprint is written before the PUT, so "invalid" is never said before it is known. MR-17 is
    killed; MR-16 (the "not decided yet" guard) survives (M3R-11); the never-decided case is M3R-7.
  - §3.1 4(b) (`prepareUploadRecovery`/`commitUploadRecovery`) shows before the local commit, refuses if the keyring
    moved, and treats a landed retry as done.
- **adoptWithSecret.**
  - The new-key test is the local keyring's vkId (right: M1's `sameVk` means the pinned key).
  - `confirm_older` is surfaced. `review_needed` comes out of commitKeys' merge (M3-42 killed). A stale capability is
    `rejected: stale`, never retried.
  - cfg_missing is accepted only with no readable vault (`keys.ts:402`); my MR-19, which drops that condition, survives
    (M3R-11).
- **repairKeys.** The verifiers follow P4 exactly as M4 and the FakeServer enforce it (§4): `recovery_verifier` only
  when the recovery wrap changed, and a 422 when sent with it unchanged (MR-18 killed). The openapi prose on the repair
  ("recovery_verifier from a typed recovery code") should say "when the recovery wrap changes" (M3-NOTES §3 item 17,
  agreed). The auth choice (the server's when the password wrap is the server's, else the adopted one, else new) is
  right.
- **The pw_auth operations.** Revoke, rename, reject-all and clear-history all run the pre-send check in the same
  context. Revoke is allowed in `keys_behind` and GM2-5 (M1). Turn-off is M3R-8.
  - In `needs_password` (the server rotated to a VK this device does not hold), a revoke first needs the adoption (one
    password), because the pre-send check cannot verify a bundle under an unknown VK. §3.14's "never blocked" is about
    `keys_behind` and GM2-5, so this is by design. M6's revoke screen should run `adoptWithSecret` first with the same
    typed password.
- **Capabilities.** Only M1's objects reach commitKeys: the adopt verdict, the unlockWithSync adopt, `published()`.
  - `settlePins` runs before every decision: the round, `context()`, `commitPublished`, `adoptWithSecret`,
    `commitJoin`. My MR-14 (keys.ts's context reads the unsettled identity) and MR-15 (no settle before
    `commitPublished`'s commitKeys) both survive, see M3R-11.
  - `verified` stays in this module's WeakMap (same-context rule). Nothing handed to M1 is mutated (the builders take
    copies: `setPassword`, `setRecovery`, `rekey` return new keyrings).

### 3.3 enroll.ts

- **firstUpload against §3.1 rev. 13/14 and RR-12.** The order is:
  1. the noSync truncation (`truncateForUpload`, checked inside its transact);
  2. the password and code checked against the local keyring;
  3. step 5: the identity, then `sk_sync_cfg`;
  4. step 6: the keyring read after step 5 (else `keyring_changed`, with step 5 undone). My MR-21, which makes the
     "changed" comparison vacuous, survives, but it is near-equivalent: the alignment check in the same condition
     catches every Phase 0 key operation, whose `createdAt` is the exact time and not on the hour;
  5. init with an identical retry;
  6. the "in sync" pins only if the local keyring is still the one sent (M3-15 killed).
  - An unknown answer leaves a pending identity with its copy. The round's status query either pins it from
    `GET /v1/keys` (`pinFirstUpload`, M3-28 killed) or reports `join_unfinished`, which `resumeFirstUpload` undoes
    (M6 must call it). P-3 is the one leak.
- **The joins.**
  - The recovery-code join checks vkId, MAC and vaultId with M1's `verifyReceivedBundle` (MR-22 killed), settles
    before `commitJoin`, and treats an unknown `complete` as settled by the status query.
  - The approval join drives M1's machines. MUST 3 holds (it never re-opens a request); MUST 5 holds (the CC only
    after the approve's 200, or a poll showing `approved` with the pins unchanged; my MR-20, which shows the CC after a lost answer without the poll, survives: M3R-11); MUST 8 holds (one
    poll after a lost approve answer).
  - Gaps: M3R-6 (the reveal), M3R-9 (re-join).
- **The empty remote of the approval path** is a known design gap (M3R-13); it duplicates and loses nothing.
- **Identity restore and cfg_missing.**
  - `identity_missing` is restored only once unlocked, and every restored state is confirmed by the signed status.
  - cfg_missing with a never-pinned pending identity is left alone (an enrolment in progress); with a pinned identity
    and a readable vault the turn-off is finished, no round and no signature (M3-16 killed); with a lost vault it is
    `cloud_restore`.
  - The order of `commitJoin`'s writes (`sk_sync_cfg` in the transact before the pins) means a concurrent round never
    sees "cfg_missing" mid-join.

### 3.4 Transport and signing

- `signRequest`/`signForkRequest` are M1's; the registration signature carries the session's `sub` (D2 below).
- The clone cursor is in PUT bodies only (a source rule plus M3-17 killed). The pending value is written before the
  PUT, and a lost answer is not a clone (MR-13 killed).
- `min_client_version` stops the round (M3-23 killed), but not the flows (M3R-3).
- Backoff is `min(30 min, 5 s × 2ⁿ) ± 20 %` (n capped at 30). `Retry-After` is honoured from the body or the header,
  never earlier, and capped at 24 h (MR-23 and MR-24 killed).
- Device failure counts appear as `auth_failures` notices, never as a lockout.

### 3.5 Hygiene

- **No `chrome.*`, timers, clock, logging, network or dynamic import in `core/sync/engine/`** (a source rule, read and
  re-checked by grep). The only diag phrase is "sync round failed".
- **Secrets.** No secret, code or password reaches a diag line, `sk_sync_state`, a notice or the server's log in any
  model run (their check, kept in mine). Error objects carry codes only. Info: the server's error code string is stored
  verbatim (M3R-13).
- **Popup isolation.** I tried to break it: importing `core/sync/engine/clock` from `popup/App.tsx` fails three tests
  (`m3-source-rules` ×2, `m2-source-rules`'s exact module list).
  - `dist/` holds no engine string. The only `sk_sync_*` names in the bundle are M2's key table, which is also in the
    main tree's build.
  - check-dist: popup 53.8 KB gz, unchanged.
- **Read budgets.**
  - Sync off is 2 storage.local reads + 1 IndexedDB read; the steady state 8 + 1. Both are pinned by
    `m3-read-budget` (M3-31 killed).
  - The "at most every 30 s" claim is true for `lastAttemptAt`/`lastOkAt`, and it is the cause of M3R-4.
  - My M3R-1 fix keeps eight reads in another order.
- **M2 code changed.** `sync-flows.ts` only gains methods. `committed()`'s new `session` flag was already honoured by
  `service.ts:committed`, and no existing behaviour changed. The `m2-source-rules` edit only adds
  `core/sync/engine/` to the heavy-import allow-list; `m3-source-rules` adds the stronger rules. Neither weakens an
  assertion.

---

## 4. The FakeServer as an oracle (compared with api/openapi.yaml and api/server/sixkey_server)

Each point is read on both sides with file:line. FS = `test/helpers/fake-server.ts`, M4 = `api/server/sixkey_server/`.

**The same in both** (and in the contract):
- the idempotent replay of `PUT /v1/keys` and rotate is answered before the proof check;
- P4: each verifier is required exactly when its wrap changed and refused (422) when it did not; a wrap counts as
  changed by iv and wrapped bytes; a password wrap and auth.kdf change together; rotate requires both;
- `by` must be the signing device; hour-aligned bundle times; integer number tokens; the kver window
  (`if_kver < kver ≤ if_kver + 65 536`);
- the order 401 `unknown_device` → `bad_signature` → 403 `device_revoked` → 401 `clock_skew` (with `server_time`);
- the error shape and its details; `Retry-After` as both a header and a body member;
- `head` and `size_bytes`; the cursor/`forked` rule; **413 `too_large`** for an oversized envelope (the engine's
  mapping, `engine.ts:506`, is right);
- the 9 MiB / 64 KiB body limits; the history (newest first, head included); `DELETE /v1/vault/versions`; the per-state
  fields of the poll views; pw_auth for renaming and revoking this device too; the fork header; auth_failures capped
  at 10.

**Differences that matter to the engine, most important first:**

| # | Difference | FS | M4 | Engine consequence against M4 |
|---|---|---|---|---|
| D1 | `min_client_version` default | `"0.0.1"` (FS:213) | `"0.1.0"` (config.py:59, :97; the Makefile does not override it) | the extension is 0.0.1: **every round stops with `update_required`** until the server is configured or the manifest bumped (M5) |
| D2 | the account session | an opaque token; the test helper hands back `sub` (FS:230-237, 667-670) | a Supabase ES256 JWT whose `sub` signs registrations (auth.py:63-69, pipeline.py:305) | `AccountSession {token, sub}` is never derived from `verify`'s answer (api.ts:154): without decoding the JWT's `sub`, init and both enrolments are 401 `bad_signature` (M5/M6) |
| D3 | `PUT /v1/keys`: proof before CAS (rev. 15 A5 makes M4's order the design) | FS:808-809 | CAS (`keys_conflict`) before the proof (keys.py:43-45; M4-NOTES A5: a race is not a wrong password) | the race "another device changed the password meanwhile" is `password_mismatch` on FS (and counts an auth failure: a false "wrong password" banner after three) but `keys_conflict` → reconciled → `changed_elsewhere` on M4. `m3-edges.test.ts:210-218` asserts the FS answer and would fail against M4. The engine handles both; the FakeServer should follow M4 |
| D4 | rotate check order (rev. 15 A7: M4's is the design) | proof → envelope → write_denied → version → keys (FS:829-833) | shape → idempotency → keys_conflict → version_conflict → write_denied → proof (keys.py:72-88) | FS gives `password_mismatch` where M4 gives `changed_elsewhere` (the rotation void, as §3.8 wants); with both stale, FS costs an extra merge round |
| D5 | `PUT /v1/vault`: write proof before CAS | FS:748 before 751-752 | CAS before `write_denied` (vault.py:166-171) | after a racing rotation FS answers 403 (the round errors and backs off), M4 409 (restart → `needs_password`): M4's is better; the engine copes with both |
| D6 | retried `complete` (rev. 15 A17: 410 is the design) | 200 from a tombstone (FS:989-995) | 410 `enroll_gone`, the row deleted (enroll.py:221-226, A17) | after one lost answer `commitJoin` returns `unconfirmed` (enroll.ts:251), settled by the next status query; with M3R-9 a dead end is easier to reach on M4 |
| D7 | rate limits | none (faults only) | per device, account and session; wrong proofs 10/min then 429 with no DB write; recovery 5/h per account+IP, 50/day, never refunded (pipeline.py:111-188, enroll.py:289) | the engine's 429 path is right; the recovery join's 3 tries spend the hourly quota (P-4); a long F6a walk can pass 60 reads/min |
| D8 | `reject-all` scope (rev. 15 A14: every open request created up to `minute_floor(Sixkey-Ts)`, recovery ones too, is the design) | approval requests only (FS:1031) | every open request, recovery ones too (enroll.py:269-276) | another device's recovery join in progress gets 410 at complete → `join_unfinished` (M3R-9) |
| D9 | retention | history never pruned | pruned in PUT and rotate and daily (retention.py:26-68) | a version pruned mid-walk is a 404 that fails the round (P-2) |
| D10 | resetting auth_failures | no `devices_rev` bump (FS:568) | bumps `devices_rev` (pipeline.py:174-181) | on FS the engine's `warn` flag can go stale and miss a second "wrong password" banner |

**Smaller differences that the engine never reaches today** (D11–D19):
- Body checks run before authentication on FS and after it on M4.
- M4 is stricter: 422 for duplicate keys, NUL and lone surrogates; `name_ct.vkId` must be the current VK; rotate's
  duplicate names; `name_ct` in the approval path's complete; an empty body.
- FS is stricter: the upload-mode auth salt rule; removed headers and `|`.
- M4 answers an identical retry of respond/reveal with 200, FS with 409 (a resend is safe on M4: M3R-6's fix).
- PUT /v1/keys checks shape and window first on M4.
- Init idempotency: FS compares with an init snapshot, M4 with the current bundle.
- `expires_at` rounded up to the minute on M4 (exact on FS).
- A device-side reject without pw_auth: 403 on M4 (422 on FS).
- `last_seen_at`; rotate's `devices_rev` bump; the in-transaction revocation re-check; `handled_by` placement; header
  and lookup order; the version-number digits; device list order; bodyless caps.
- M4 can send `server_time: 0` from its outermost 500 handler (main.py:125). The engine then takes a −7-day offset for
  one exchange and recovers through the `clock_skew` retry.
- The FakeServer's own tests at m3-fake-server.test.ts:463-465 (12 × 403), :575 (exact expiry), :594 (409 on a
  repeated respond) and :603 (200 on a repeated complete) encode FakeServer-only behaviour.

**Verdict on the oracle.**
- The FakeServer is a faithful model for everything the engine's correctness depends on: the CAS, idempotency, P4, the
  kver window, the signatures, head and size.
- It is more lenient in ordering (D3–D5), retries (D6), limits (D7) and retention (D9). None of these hides a data-loss
  bug: the engine survives M4's choices in every case.
- **Before M5's e2e, align D3, D4, D6 and D8 with rev. 15 (M4's behaviour), and D5 with M4** (the openapi lists but does not order it), so the M3 tests run against either backend. Fix the FakeServer-only assertions (m3-edges:210-218, m3-fake-server:463-465, :575, :594, :603).
- D1 and D2 are configuration and wiring items for M5.

### 4.1 The engine against the real M4 server (live)

Agent-run, in its own copy `scratchpad/m3-m4live/`:
- M4's suite, 336 passed, on its own Postgres cluster (TCP 127.0.0.1:55491; the scratch path is too long for a unix
  socket on macOS, so `make check` ran as the equivalent pytest command);
- the server on 127.0.0.1:8791, with the per-IP OTP and recovery limits relaxed as the server's own conftest does
  (device, account and session limits at their defaults);
- the M3 engine over a Node `fetch` transport, the account session's `sub` taken from M4's JWT, and the OTP from the
  FakeAuthProvider's inbox.
Harness: `m3-m4live/extension/test/live/`. Every edge test runs on both backends; logs hold method, path, status and
code only.

| Scenario | Live M4 |
|---|---|
| a first upload + round; b recovery join; c edits until quiet (no PUT when nothing changed) | pass |
| d a real 409 race; e the locked outbox push | pass |
| f a new recovery code (the other device adopts); g a password change (`needs_new_password`, then adopt); h a rotation (`needs_password`, adopt, every name under the new key, B's edit kept) | pass |
| i revoke (`rejected_by_server`, data kept), rename, reject-all, clear history | pass |
| j the approval join (SAS and CC typed across) | pass |
| k1 a lost `PUT /v1/vault` answer (no second upload, not `forked`); k2 a lost `PUT /v1/keys` answer in `commitRecoveryCode` (reconciled, `recovery_in_effect`) | pass |
| E5 a rotation racing a data change; E6 lost answers of init, the recovery enrolment, keys and rotate; E7 a clock 10 min ahead; E8 three devices editing (about 8 real 409s); E9 a clone (`forked`); E10 turn off and join again; E12 a lost approve answer | pass on both backends |

The differences it found are §4's:
- D1: `update_required` on a default M4. Also, init has no version gate, so an old client can create a vault it then
  cannot sync: a point for the design owner.
- D6: `commitJoin` → `unconfirmed`, settled by the next status.
- D3: password_mismatch versus changed_elsewhere; `m3-edges.test.ts:210-218` would fail live.
- D5 → M3R-14.
- D8: reject-all also kills recovery joins, while M4's list shows approval requests only (an M4 issue for its review:
  the approver sees 0 pending and is told 1 was rejected), and the joiner ends in `join_unfinished` (M3R-9).
- M3R-15.

**On the live server every convergence check passed.** No data-loss difference between the FakeServer and M4 was
found. The two data-loss bugs of §1 are engine bugs that both backends let through (the server CAS is satisfied by
construction).

---

## 5. Tests

### 5.1 The implementer's 43 mutants

They are real bugs, not trivia.
- They cover the CAS, the outbox, D5, R6 on both paths, the guard on all three merge paths, the stale capability, the
  first-upload pins, cfg_missing, the cursor, the 409 path, the backoff, settle, the kill switch, P5, and server-first
  key changes.
- I re-read every replacement. Each one is the bug its name says, and each typechecks.
- Two are weaker than they look:
  - M3-01's first killer is an outbox test, not a merge test;
  - M3-11 "dirty by seq" is a stand-in, as the notes say.
- None targets the two places the real bugs are: the order of the state read against `current()`, and the rotation's
  base. So "43/43 killed" says the listed mechanisms are tested, not that the write path is.

### 5.2 My mutants (31; `m3r-scripts/mutr.py`, run as theirs: tsc, the 15 M3 files with `--bail 1`, then the whole suite)

*Unfinished in this session: the final table was not written. See `docs/design/notes/M3-NOTES.md` §7 for the results of all 31.*

### 5.3 The model, extended (`test/review/m3r-model.test.ts`)

The implementer's model runs every step sequentially, with three devices, and never tears a slot, rotates, changes a
password, or interleaves two operations. Mine keeps their whole step mix and their checks, and adds:
- four devices (clocks 0, +2 d, −2 d, +3 h);
- **tear**: a slot torn after a synced round, then a worker round, or the popup first;
- **hook**: a server hook inside the device's own in-flight PUT, running an edit there, another device's write (a
  409), or another context opening the popup;
- **pw**: password changes, a third of them with the `PUT /v1/keys` answer lost.

Results:
- **On the patch, with tears:** the first run fails, by `watchServer` ("a write did not absorb the head it replaced"):
  M3R-1.
- **Without tears:** 150 runs × 70 steps (seed 777), green.
- **On the fix copy** (M3R-1 and M3R-2 fixed), with every family: 60 × 60 (seed 99), green.

Two of my own families turned out to be double failures that the design does not cover, so I removed them and
document them here as harness lessons:
- a slot torn during the device's own PUT, combined with a later PITR rollback, loses the newest local state twice;
- server rollbacks combined with tears.

Not done in the model: rotations, which need a per-device current key in the harness (covered by the R2 probes), and
real concurrency inside one device beyond the server hooks.

---

## 6. Sound (checked and holding)

- The lastSynced CAS (generation and value) and the outbox's D2/D5 CAS, including the lost-answer recognition.
- needPull by (version, head); the A5 warning; every rollback shape.
- Clamp both sides, compare with the raw remote; the offset clamp (±7 d); TOTP on the local clock (S3).
- The F6a walk and R6 on the head and during the walk.
- The guard on the round, the key adoption and the rejoin; blocked merges keep nothing; answers bound per remote entry.
- The stale-capability rule (evaluate again, never retry); settle before decisions in the engine; the same-context rule.
- The server-first key operations, §3.6.0 reconciliation and resend, show-before-commit, and P4 in the repair.
- §3.1's local half (RR-12) and the identity-restore and cfg_missing rules.
- The source rules, popup isolation, secrets hygiene, read budgets, and the M2 edits.
- The backoff and Retry-After bounds; the 409 limit; the cursor.

---

## 7. Verdict

**MERGE AFTER FIXES.**
- The engine's design and most of its code are right, and they are tested better than any milestone so far. The
  defence in depth (needPull by head, the CAS on every lastSynced write, the outbox's head) is real: it turned several
  of my mutants into harmless ones.
- Two write-path bugs violate the two invariants the milestone exists for: D1's "an older local state never replaces a
  newer head", and the server CAS's "never upload over a head you have not merged". Both have small fixes, which I
  prototyped and tested (§1).

**Must be done before merge:**
- M3R-1, with its probe as a regression test and the model's tear step;
- M3R-2, with `watchServer` covering rotate;
- the guard test gap in M3R-11 (MR-06: a changed secret that loses by HLC still asks), plus F5's end-to-end test (R11).

**Must be done before M5 wires the engine:** M3R-3 (the kill switch on flows), M3R-12 (`pending_enrollments`), and
aligning the FakeServer's D3–D6 and D8 with M4 (§4). The rest are low.

**Counts:**

| Severity | Confirmed | Plausible |
|---|---|---|
| Critical | 1 (M3R-1) | 0 |
| High | 1 (M3R-2) | 0 |
| Medium | 2 (M3R-3, M3R-11) | 0 |
| Low | 9 (M3R-4 to M3R-10, M3R-12, plus R1b inside M3R-1) | 4 (P-1 to P-4) |
| Info | 1 group (M3R-13) | — |

**Top three:**
1. **M3R-1:** a round that is the first to load a damaged vault uploads the recovered, older state over the head; the
   synced accounts it lacks disappear from every device.
2. **M3R-2:** the rotation overwrites another device's concurrent write with unmerged data, because `if_version` comes
   from a fresh status and not from what the uploaded vault merged.
3. **M3R-3:** `min_client_version` stops rounds but not password changes, new recovery codes, approvals or enrolment.
   The server's kill switch does not cover the writes that matter most.

## 8. The M5 hand-off checklist

What M5 must wire, and verify before shipping:

1. **Preconditions:** M3R-1 and M3R-2 merged with their tests; M3R-3 and M3R-12 fixed; the FakeServer aligned with M4
   on D3–D6 and D8 (or those tests marked FakeServer-only).
2. **The outbox:** in `platform/runtime.ts`, `createSyncPort`'s port gains `afterCommit: createOutboxWriter(local)`.
   - M2's exact popup module list in `m2-source-rules` gains `core/sync/local/outbox.ts` deliberately.
   - Re-measure check-dist (M3-NOTES measured +764 B, 54.5 KB, budget 60 KB).
   - Verify P10: an edit in "lock every time" mode, the popup closed at once, is pushed by the worker.
3. **One `SyncEngine` per syncing context:** the service worker and the settings page, never the popup (the source
   rule holds). Its `EngineDeps`:
   - `origin`: the configured API origin, equal to M4's `SIXKEY_API_ORIGIN` (the signed host; a mismatch gives
     `wrong_origin` or `bad_signature`);
   - `clientVersion`: `chrome.runtime.getManifest().version`;
   - `vaultLock`: `webLock("sixkey-vault")`;
   - `syncLock`: `webLock("sixkey-sync", { ifAvailable: true })`, held by the context that runs the round. **The
     worker's transport serving a page never takes it** (§4.9 D10);
   - `now`: `Date.now`; `sleep`: a `setTimeout` promise; `rng`/`random`: `crypto.getRandomValues`;
   - `hlcDevice`: `sk_device`; `diag`: the existing diagnostics sink (codes only).
4. **The transport (`platform/api.ts`):**
   - fetch to the one API origin only, bundled into `sw.js` only (check-dist enforces it);
   - pages reach it through `chrome.runtime.sendMessage({type: "sk-api"})` with the existing `sender.id` check; the
     page's engine signs, the worker only sends;
   - every failure whose outcome is unknown (timeout, abort, the worker stopped) rejects with `NetworkError`;
     response header names are lower-cased (`date`, `retry-after`); the body is the raw text.
5. **Timers:**
   - a `Wake` with `via: "timeout"` → `setTimeout`; with `via: "alarm"` → `chrome.alarms` (`sk-sync-kick`, the retry
     alarm). On firing, call `engine.wake(name)`.
   - `engine.start()` at every worker start.
   - `sk-sync-periodic` (30 min), created once with `periodicPhaseMinutes(random)` as its first delay.
   - `sk-sync-soon` from pages → `engine.kick()`. HOTP → `kick({ immediate: true })`, plus the UI's 2-second
     `Promise.race(round)` before showing a code (§4.12).
6. **The popup** renders local data first and asks the worker for a round when `lastOkAt` is more than 30 s old. It
   never builds an engine. TOTP's correction (`totpOffset`, `clockNotice`) must move out of `core/sync/engine/` to a
   popup-eligible module (M3R-13).
7. **The badge:** `chrome.action.setBadgeText` from `pending_enrollments`, locked too, which needs M3R-12.
8. **Configuration (§4 D1, D2):**
   - M4's `min_client_version` default `0.1.0` against the extension's `0.0.1`: set `SIXKEY_MIN_CLIENT_VERSION` or bump
     the manifest, else every round is `update_required`.
   - Build `AccountSession {token, sub}` by decoding the `sub` of M4's JWT in the page. It is not verified there; the
     server verifies it.
9. **Manifests and check-dist (SYNC-DESIGN §7):** the three manifests (prod, dev, e2e) with the API origin as the only
   `host_permissions` entry and CSP `connect-src`. check-dist enforces fetch only in `sw.js`, no engine module in the
   popup, the popup budget and the permission allow-list. Rewrite `network.spec`.
10. **e2e against the real M4 server**, first through a Node fetch transport on the M3 tests that need only
    `transport()` and `session()` (M3-NOTES §1.3), then Playwright with 2–3 persistent contexts (SYNC-DESIGN §8.6). Each must pass
    on M4:
    - first upload; the approval join (SAS and CC typed across pages); the recovery join; a join into a profile with
      accounts (`sk_prejoin`);
    - concurrent edits converge; revoke; rotate, then adopt with the password; change the password; a new recovery
      code with its answer lost (the UI never says "invalid");
    - offline edits; the worker killed mid-round;
    - **a torn active slot followed by a worker round with no popup open (the M3R-1 regression)**; a rotation racing
      another device's write (M3R-2);
    - a rollback; a remote bulk delete (notice plus "find accounts"); a remote erase of a live account (blocks, then
      [Apply] re-pulls).
11. **The enrolment screens:** MUST 7 and 8 (no polling while approve is in flight). The reveal resend is M3R-6 (M6).
12. **Visible events:** "keys adopted back" (RR-6) from the `keys_adopted` notice and security record.
13. **Shipping gate:** "turn sync on" does not ship before M6's sync settings exist (⊗).
14. **For M6, from the engine's API:**
    - `resumeFirstUpload` on `join_unfinished` for a first upload, and `removeSyncIdentity` then a new join for a
      join's `join_unfinished` (M3R-9);
    - a `review_needed` answer kept in page memory only;
    - the repair with a newly generated code and the `server_older_key` repair (M3-NOTES §8, still to build);
    - fork; "rejoin from the cloud";
    - display of the stored `lastErrorCode` as untrusted text.
