# M2 implementation notes (M2-NOTES)

Date: 2026-10-17, revised twice the same day: after the review (`docs/audit/internal-reviews/M2-REVIEW.md`, "merge after fixes")
and after the re-review of those fixes (`docs/audit/internal-reviews/M2-REREVIEW.md`, "M3 after fixes"). What M2 built (SYNC-DESIGN §9, M2 row;
§0.0i "M2 storage requirements" 1–18), the decisions the design left open, and what M3, M5 and M6 must know.
SYNC-DESIGN.md is not edited here. Revisions 12 and 13 of the design (§0.0i items 2 and 16–18, §0.0l, §0.0m) record the
first review's decisions and M2's rule for item 18 (§4.1 below). §8 goes through both reviews finding by finding; §8.4
is the re-review, and §9 lists what the design owner should add after it. Paths under `scratchpad/` name the private
working copies the mutation runs were made in; they were not retained and are not part of the repository.

---

## 1. What exists after M2 (the surface M3 builds on)

| Piece | Where | Who builds it |
|---|---|---|
| `transact(fn, opts)`: `fn(current, info)`; `opts`: `overwriteLost`, `keyChange`, `ensureCurrentSnapshot`, `afterCommit(gen)`, `event` | `core/storage/store.ts` | every caller |
| `StoreOptions.beforeRecoveryWrite` (D1) | `store.ts` | `platform/runtime.ts` wires it to `SyncStateStore.clearLastSynced` |
| `openVault` with previous-VK candidates (I3); the only `keyChange: true` writer (§0.0i item 2) | `store.ts` | — |
| `SyncPort` (the service's view of sync: `context`, `clearLastSynced`, `afterCommit?`) | `core/service/service.ts` | `core/sync/local/port.ts` (`createSyncPort`), in every context |
| The two `VkRecord`s, cleanup part only (`SyncCfgRecord`, `PrejoinRecord`) | `core/sync/local/records.ts` | the port; `ServiceDeps.vkRecords` |
| `SyncLocal`: the identity store, the pins ledger (`pins`: `begin`, `commit`, `view`, `settle`), `settlePins()`, both records with their writers and openers (`cfg.setState`, `prejoin.check`), `status()` (the four combinations, settled), `restoreIdentity`, `turnOff` | `core/sync/local/sync-local.ts`, `identity.ts`, `pins.ts`, `record-writers.ts` | **M5**, in the service worker and the settings page (never the popup) |
| `SyncFlows`: `applyRemote`, `commitKeys`, `prepareJoin`/`commitJoin`, `restoreSyncIdentity`, `turnOffSync` | `core/service/sync-flows.ts` | **M5**: `new SyncFlows(rt.service, syncLocal)` |
| The commit capabilities: the `adopt` verdicts of `evaluateSameVkBundle` and `unlockWithSync` (`Adoption`), and `published()` (`Published`) | M1: `core/sync/crypto/bundle-eval.ts`, `presend.ts`, `capability.ts` | M3 |
| `guardMerge`, `blocks`, `notices` (§4.4) | `core/sync/local/guard.ts` | M3 runs it before applyRemote; applyRemote runs it again |
| `uploadEnvelopeBytes`, `editFits`, `exemptFromSizeCheck`, `MAX_ENVELOPE_BYTES` (§4.3) | `core/sync/local/size.ts` | mutate (sync on) |
| `SYNC_KEYS`, `SYNC_OFF_KEYS`, `LOCAL_ONLY_KEYS` (R5), `IDENTITY_DB` | `core/sync/local/keys.ts` | — |
| Security record v2 with the new kinds (R8); their labels `secK*` | `core/service/security-log.ts`; `options/SecurityCard.tsx`; text in `scripts/i18n/m2.py` | — |

**What M3 calls, in order, for its flows.** None of them touches the network, and all go through the vault lock.
- **Before every decision** (every adoption or pre-send decision, and every unlock with sync on): `syncLocal.settlePins()`,
  or `syncLocal.status()`, which settles too. Feed M1 the settled identity's `vkId`, `vaultId`, `maxSeenKver` and
  `adopted`. Never call either from inside the vault lock.
- **A merge**: run `guardMerge` on M3's own copy, then `flows.applyRemote(remote, answer?)` → `{changed, checksum, vault, guard}`.
  - A stopped merge throws `MergeBlocked` (code `review_needed`), which carries `report` and `seen`.
  - [Apply] re-pulls and passes `{seen: err.seen, accept: ids}`; [Keep mine] passes `{seen, keepMine: ids}`.
  - The answer holds only for the remote versions in `seen`.
- **A key commit**: `flows.commitKeys({keys, remote?, overLost?, answer?, record?})`, where `keys` is exactly what M1 returned:
  - `evaluateSameVkBundle`'s `adopt` verdict (R2; the GM2-5 adopt-back);
  - `unlockWithSync`'s `adopt` result (R3, R6, the cloud restore);
  - `published({verified, sent, vk, secret, held?})` once the server accepted this device's own operation (§3.6–§3.8, §4.2's
    repair). `verified` is the pre-send check's `VerifiedServerBundle`; `secret` is the one the sent keyring was built with.

  `commitKeys` refuses anything M1 did not issue in that JS context (`bad_state`). It checks continuity, the pins and the
  lock-out guard itself (§2, item 16), and last that the stored keyring is still the one M1 judged (the capability's
  `base`) or the bundle's own (a landed retry): otherwise `bad_state("stale")`, nothing written, and M3 evaluates again
  (RR-1). What a capability carries is M1's frozen copy, taken at issue (RR-2). It writes `bundle.keyring` itself,
  clears `lastSynced` and writes `pendingPins` before the commit. After the commit it writes the pins, records, starts the session, and runs the one cleanup entry
  point with the old VKs the keys carry.
- **The join**: `flows.prepareJoin({bundle, vk, remote, device, confirmLost?, answer?})` → show `{mode, added, skipped}` →
  `flows.commitJoin(handle)`.
  - The profile's device identity must be there and be the joining device's, pinned to no other vault (RR-3: a join
    after "turn sync off" removed it is refused).
  - In added mode, an earlier join's `sk_prejoin` refuses the join (`prejoin_exists`). This attempt's own record, from a
    try that died before its commit, does not: the same cloud key, vault id and plaintext (RR-5).
  - A retry of the same handle after a write that landed and reported an error counts as done. It writes its pins inside
    the lock.
- **`identity_missing`**: `syncLocal.status()`, then `flows.restoreSyncIdentity({maxSeenVersion})` once unlocked. The
  identity comes back in the state `sk_sync_cfg` mirrors: "pending" unless M3 recorded more with `cfg.setState`.
- **The outbox**: set `SyncPort.afterCommit` (the runtime's port object is `rt.sync`; M3 adds the member). mutate and
  applyRemote call it inside the lock after a commit of new data, guarded.
- **Turning sync off**: `flows.turnOffSync()`. It takes the vault lock (and the identity's), so a key commit or a join in
  another context lands before it or after it, never across it (RR-3). Never call it while holding the vault lock.

## 2. Requirement map (§0.0i 1–18)

| # | Requirement | Code | Tests |
|---|---|---|---|
| 1 | Keyring-changing writes through `transact`, judged by `canonicalJson` | unchanged; `commitKeys`, `commitJoin` use it | the crash matrices (atomic keyring), existing `keychange-marker` |
| 2 | `keyChange: true` only for the previous-VK fallback (revision 12); applyRemote writes none | `store.ts openVault` (`{keyChange: oldKey}`); applyRemote passes no `keyChange` | `m2-store` "the newest copy that opens is under VK1 … marker"; `m2-service` "merges both sides … no marker" (`loadView().cleanup === "none"`, keyring byte for byte); `read-budget-sync` "first open after applyRemote" ≤ 4, same keys; `m2-review` PROBE-9; mutants M01 (inverted), M16 |
| 3 | `StoreOptions.lock` required; only runtime builds a store | unchanged | existing `source-rules`; `m2-source-rules` |
| 4 | Cleanup = `finishKeyChange(current VK, callback)`; unknown key: same vault kept, other dropped | unchanged | existing; `m2-service` join (D9) |
| 5 | One cleanup entry point; `VkRecord` contract for `sk_sync_cfg.enc`, `sk_prejoin` | `records.ts` (`VkEncryptedRecord`); `service.ts finishKeyChanges` | `m2-records` (A4R-4 race per record; a read error keeps the marker; **the runtime's own record list moves both**, R06); mutants M10, M23, M24, M28, R06, R07, R17 |
| 6 | Adopting a keyring that does not list the old key: cleanup by the marker | `commitKeys`/`commitJoin` through `transact` | the crash matrices (marker gone after the next unlock, records under the new key) |
| 7 | `sk_store_v` per store; mirror-only marker | unchanged | existing |
| 8 | `openVault` fallback: read errors, A4R-3 mirror exception, with previous-VK candidates | `store.ts openVault` | `m2-store` |
| 9 | Identity record (§0.0f 1–5), D8 both directions | `identity.ts` (`setPins`: one write, maxSeenKver never lowered, `pinCount` one up; `putIfAbsent`; `remove(first)`); `pins.ts`; restore in `sync-local.ts`; `turnOff` under the vault lock | `m2-sync-local`; `m2-service`; `m2-local-tail-lost` (GM2-5, five operations); `m2-rereview` RR-3, RR-3b, Q13, Q20, Q21; the crash matrices; mutants M03, M04, M29, Q13, Q20, Q21, S08, S12 |
| 10 | `capPrevious` only with no marker | `service.ts capped()` | `m2-service` 65th rotation, cleanup_pending; `m2-review` PROBE-9; mutants M11a, M11b, M27 |
| 11 | "Data unreadable" offers the cloud restore first | the service half: `commitKeys({keys: unlockWithSync adopt, remote, overLost: true})`; the screen is M6 | `m2-service` cloud restore |
| 12 | Keyring byte-stable | `commitKeys` writes `bundle.keyring` itself | `m2-service`; mutant M35 |
| 13 | Erasing reaches another vault's copies by secret | `service.ts purgeForever` | `m2-service`; mutant M22 |
| 14 | Recovery keys leave only via `onCode` or show-before-commit | unchanged; `commitKeys` never sees a code | existing |
| 15 | YubiKey reservations R1, R2, R3, R5, R6, R8 | as before (`untrusted`, `entryIdentity`, `LOCAL_ONLY_KEYS`, v2) | `m2-store`, `m2-service`, `m2-source-rules`, `m2-sync-local`; mutants M06, M07, M34, R14, R15 |
| 16 | `commitKeys` takes only M1's capabilities and checks what needs no secret | M1 `capability.ts` (`issue`: a frozen copy with `base`; `keysOf`), `bundle-eval.ts` (adopt verdicts registered), `presend.ts published()` (bound to the pre-send check's local keyring); `sync-flows.ts commitKeys` (`checkPins`, continuity, the lock-out re-checks, `stale`) | `m2-service` "only with keys M1 issued" (6 cases), `m2-review` PROBE-7, `m2-rereview` RR-1 (3 cases), RR-2 (2); `sync-crypto-m2` "the commit capabilities"; `m2-source-rules` (who issues, who reads); mutants N10–N25, R01, R02, S01–S07, Q09, Q38 |
| 17 | Pins catch up with the commit | `pins.ts` (`begin` in the transact, `commit` after it with a read-back, `view`, `settle`; the copy bound to its identity and ordered by `pinCount`); `SyncLocal.settlePins`, `status` | `m2-review` PROBE-1, PROBE-2, PROBE-2b/15 and "status() reports the settled identity"; `m2-rereview` RR-3, RR-4; `m2-sync-local` "the pins catch up" (RR-3, RR-4, RR-7, RR-9 cases); `m2-settle-reads`; the crash matrices ("pins behind after the settle" never, the lying disk included; the D8 window reached) and `m2-crash-settle` (the settle itself through every crash point); mutants N01–N09, R05, Q01–Q07, Q16, Q18, Q36, S08–S16 |
| 18 | Phase 0 key operations while sync is on | `service.ts noSync()` in all six (§4.1); the settings page's text for `sync_on` (`options/shared.tsx`, RR-11) | `m2-review` PROBE-4 (every method, wrong passwords too, nothing written or recorded) and "the check is inside the transact"; `m2-rereview` Q10, Q11, Q19; `m2-source-rules` RR-11; mutants N40–N47, Q10, Q11, Q19, Q22, S18 |

The §9 M2 row's other items:
- `ensureCurrentSnapshot` and `afterCommit`: `m2-store`; mutants M02, M18, M25, R04.
- `beforeRecoveryWrite` at every site: `m2-store`; mutants M13–M15, R16, R29.
- The size check: `m2-sync-local`, `m2-service`, `read-budget-sync`; mutants M05, M19, M20, R08, R09, R18, R30.
- C13: `m2-service`; mutants M36, R11.
- The corrected clock: mutant M38.
- The DSK copy: mutant M09.
- §2.5's four combinations (mutant M08) and turning sync off (mutants M30, R14).
- The join: mutants M31–M33, M44, R19, R21.
- "A recovery does not overwrite newer server data": mutant M21.

## 3. Measurements

- **Read gates, sync off** (`read-budget.test.ts`, untouched): open 4, lock screen + unlock 7, degraded unlock 10, mirror
  reads 0. These are the same numbers as main.
- **Read gates, sync on** (`read-budget-sync.test.ts`), with `sk_sync_cfg`, `sk_sync_state`, the device-key copy and
  `sk_prejoin` present:
  - open 4 and unlock 7, reading exactly the same keys as with sync off;
  - degraded unlock 10;
  - **the first open after an `applyRemote` is 4**, reading the same keys as any open. It was 29 (a full cleanup) before
    Q1 dropped applyRemote's marker;
  - a local edit reads the sync state once, with sync off too: 9 reads in that fixture, one more than main (M2R-20).
- **Popup size** (check-dist): main before M2 51.2 KB gz (static 47.3) → **53.8 KB gz** (static 49.9), against the 60 KB
  budget. The re-review's fixes add nothing to it: **55 069 bytes before and after them** (measured byte for byte with a
  copy of check-dist's computation). None of their code is in the popup's graph, and RR-11's text lives in the settings
  page's own module (`options/shared.tsx`), not in `src/ui/errors.ts`, whose table the popup carries.
  - The full catalogs: en 8.9 → 9.2 KB, zh_CN 10.1 → 10.4 KB (10 693 bytes; RR-11's four strings add 0.1 KB each),
    against the 12 KB gate. The popup catalogs are unchanged (en 3.3, zh_CN 3.9). The popup catalog has none of M2's
    settings-page keys (`secK*`, RR-11's), which `m2-source-rules` asserts.
  - What M2 puts in the popup is fixed by the module-graph rule (`m2-source-rules`, M2R-8), not by import names:
    - sync's modules in the popup's graph are exactly `local/{keys,port,records,size,state}.ts` and M1's
      `{constants,encoding,errors,keybundle,labels,padding,subkeys}.ts`;
    - the reviewer's bypass through `port.ts` (+1.8 KB gz) fails that rule (mutant N95).
- **The settle's read cost** (`m2-settle-reads`), for M3's budget in the service worker and the settings page (never the
  popup's open or unlock): in the steady state one storage.local read (`sk_sync_state`) and one IndexedDB read, nothing
  written; `status()` one storage.local read more (`sk_sync_cfg`). With a pending copy to apply: 5 storage.local reads,
  3 IndexedDB reads (the view, `setPins`' own, the read-back) and 2 writes.
- **Unit suite**: 82 files, 1305 tests passed, 1 skipped, about 2 min wall (main with M2 merged: 78 files, 1277). The
  longest files are the crash matrices: `m2-crash-matrix` (single faults and the lying disk, seven operations) and the
  three `m2-crash-double-*` files (two operations or three each, so they run side by side).
- **Mutation check** (`scratchpad/m2/scripts/mut3.py`): each mutant is one exact replacement, then tsc, then the whole
  vitest suite. **170 mutants, 164 killed, all by tests; 6 equivalent** (§8.3). They are my 128 from the two earlier
  rounds, the re-reviewer's 25 and 17 new ones, each ported where its target moved.

## 4. Decisions and doc ambiguities (for the design owner)

### 4.1 M2R-3 / §0.0i item 18: the rule, for the design text

**Rule: while sync is on (the profile has `sk_sync_cfg`), the six Phase 0 key operations are refused with
`ServiceError("sync_on")`.** The six are `enableMasterPassword`, `rotateKey`, `changePassword`, `prepareReset`,
`commitReset` and `newRecoveryCode`.
- Nothing is written or recorded, and no code is shown.
- The key operations with sync on are §3.6–§3.8. They go to the server first, then `SyncFlows.commitKeys` with a
  `Published`. M6 sends the user there.

Why block rather than route:
- The Phase 0 methods commit locally first. §3.6.0 and §3.7 put the server first ("先服务器后本地"), so routing them would
  mean a network step inside the service, which M2 does not have.
- §3.1 step 4(b) still uses the Phase 0 local commit for a new recovery key. That runs before `sk_sync_cfg` is written
  (step 5), so the rule does not touch it.

Where the check runs:
- **Inside each operation's transact.** A join turning sync on in another page cannot slip in between. `m2-review` has a
  test where sync is turned on while a rotation waits for the lock.
- **At the top of `prepareReset` and `newRecoveryCode` as well**, before any secret is checked or recorded. A refused call
  leaves no `unlock_failed` or `recovery_used` entry.
- **In `commitReset`, after the "already landed" check.** A reset that landed before sync was turned on still counts as
  done.

Cost: one read of two keys, and only in these operations. The popup runs none of them.

Proposed wording for item 18: "同步开启时（存在 `sk_sync_cfg`），这六个 Phase 0 密钥操作一律以 `sync_on` 拒绝，什么都不写、不记录；同步开启时的密钥操作是 §3.6–§3.8（先服务器，再 `commitKeys` 的 `Published`）。检查在各自的 transact 内（另一页面开启同步不能插进来），`prepareReset`、`newRecoveryCode` 另在检查秘密之前先查一次。"

### 4.2 The other decisions

1. **applyRemote writes no marker** (Q1, §0.0i item 2 rev. 12): `keyChange` is gone from applyRemote, and `store.ts`'s
   header says so. PROBE-9 now passes: a 65th rotation right after a sync is not refused. With sync on, the Phase 0
   rotation is refused by item 18 anyway; with sync off it rotates to 64 previous keys. The design text was amended by
   its owner (revision 12).
2. **`beforeRecoveryWrite` sites, failing closed** (Q2): kept as built. The hook runs at §3.13's sites plus FIXa2's
   rollback, not at the redundancy heals. A hook read error fails the recovery, and a retry recovers (PROBE-8, kept as a
   regression test). The reviewer's note for the design owner is to record both points in §3.13 and to withdraw
   GM2-REVIEW's GM2-8 line.
3. **The pins are written twice** (§0.0i item 17, M2R-1):
   - First, inside the transact, as `sk_sync_state.pendingPins`, in the same `kv.set` as `lastSynced`'s clear and always
     (`pins.begin`).
   - Then into IndexedDB after the commit, read back, after which the pending copy is cleared (`pins.commit`, guarded).
     The read-back (one IndexedDB get) is the re-review's RR-7: on a disk that acknowledges a write and drops it, the
     pending copy stays instead of being cleared over pins that never landed. The settle does the same.
   - The pending copy also carries `deviceId`, the identity it was written for (null with none), and `prev`, that
     identity's `pinCount` when the commit began. The identity gains `pinCount` (how many times `setPins` wrote it;
     absent reads as 0), a new member of the record in IndexedDB.
   - `settle()` applies a pending copy only if it names the active keyring and moves forward. Naming the active keyring
     means the keyring read back from the slots reproduces `pending.adopted.digest` under the pending auth (a test checks
     that round trip). Moving forward means: written for this identity, the same vault, and either no pins yet, a
     higher `maxSeenKver`, or an identity whose `pinCount` is still `prev` (nothing was pinned since that commit began).
     - RR-4: "`maxSeenKver` at least the identity's", the first rule, let a stale copy of an equal-kver commit move
       `adopted` back after a tail loss. `maxSeenKver` is a maximum, not an order; `pinCount` is an order, and a digest
       would not be (pins that went A → B → A would match a stale A).
     - The same rule fixes the capped publish (a `published()` whose `sent.kver` is below the identity's `maxSeenKver`,
       F-01): its copy is applied by `prev`, and `setPins` keeps the higher `maxSeenKver`.
     - RR-3: a copy written for another identity, or for none (a commit that ran after "turn sync off"), never applies:
       a later enrolment's fresh identity does not inherit stale pins.
   - Settling drops a copy whose commit never landed, one the identity is already past (the GM2-5 state), and one for
     another identity. It keeps one when there is no identity, or no readable keyring.
   - While IndexedDB keeps failing, settle returns the pending pins laid over the stored ones, so decisions see the truth.
     With no readable keyring (the cloud restore) it lays them over too, when they move forward (RR-9: every pending copy
     names a bundle the server held, published after it accepted or adopted from it), and writes nothing.
   - `pendingPins` is a member of `sk_sync_state`, as item 17 says. **Every writer of `sk_sync_state` must keep the
     members it does not own and do its read-modify-write under the vault lock**, as the M2 writers do. This is an M3
     rule: the engine's status, backoff and `lastSynced` CAS writes must follow it.
   - Not built: the optional `adopted.from` hardening (the keyring the commit replaced). It would change M1's
     `AdoptedRecord` format. The residual it would close is RR-6 (item 12 below), not M2R-1, which settle closes.
4. **The commit capabilities** (§0.0i item 16, Q3):
   - M1's adopt verdicts are frozen and registered as they are returned, so their shape is unchanged (the existing
     `toEqual` tests and the vectors are untouched). `published()` makes the third kind.
   - What each carries is in a module-private `WeakMap` (`capability.ts`). Only `bundle-eval.ts` and `presend.ts` call
     `issue` (a source rule checks it); only `sync-flows.ts` reads them.
   - **Corrected (RR-1).** The first version said "a capability can be committed more than once; the in-lock checks make
     a replay harmless". That was false: a stale or replayed same-VK capability passed every check and wrote an older
     keyring over this device's newer key change. Now each capability carries `base`, the local keyring M1 judged it
     against: `evaluateSameVkBundle`'s and `unlockWithSync`'s `local` (null for a cloud restore), and for `published()`
     the `local` of the pre-send check that issued its `VerifiedServerBundle`. Inside the transact, after the other
     checks, `commitKeys` refuses with `bad_state("stale")`, writing nothing, unless the stored keyring is `base` or the
     bundle's own (a retry of this very commit, already landed). So a capability can be committed again only as that
     retry; M3 drops a refused one and evaluates again. The stale check comes last, so a capability the other checks
     refuse keeps their reason.
   - **M1 keeps its own copy (RR-2).** `issue` registers a deep-frozen structured clone of the bundle and of `base`, and
     copies of the VKs. Changing the objects handed to M1 after its verdict changes nothing that is committed.
   - The lock-out guard by basis:
     - `same_password_wrap` (R2): re-checked in the lock against the stored keyring;
     - `adopted_back` (GM2-5): re-checked against the settled pins. **Decision: "the bundle's digest is the identity's
       `adopted`" counts as "this device built it"**, since this device committed this very keyring after its own guard.
       Otherwise M1 change 2 (adopt back at once) could never pass through `commitKeys`;
     - `opened` (`unlockWithSync`): the typed secret opened `bundle.keyring`;
     - `built_here` (`published`): `published()` opens the sent keyring with the secret it was built with (one KDF for a
       password; the new recovery key is an HKDF).
   - Continuity in the lock:
     - the same VK keeps every real previous entry;
     - another VK's previous list really unwraps the stored keyring's VK (its data is opened with that key, not with any
       key the caller passes) and keeps the rest, bar the 64 cap;
     - the pins (the settled identity's, and a pending copy that cannot be settled) must be this vault's and reachable
       from the bundle (F7), for every commit and not only the cloud restore;
     - a cloud restore takes only `opened` keys;
     - a damaged identity refuses (`bad_state "discontinuous"`).
   - **The first upload** (§3.1): `published()` cannot cover it, because there is no server bundle to verify against.
     Revision 13 settled this without an issuer: the `createdAt` truncation is a local keyring transact before `init`,
     and after 201 only the pins are written. RR-12 adds a check for that design text (§9).
5. **The join writes into the joining device's identity only**:
   - `commitJoin` refuses (`bad_state`) when the profile's identity is another device's, is pinned to another vault, or
     is not there at all (RR-3: a join prepared before "turn sync off" removed it). A new device's identity has no pins
     yet (§3.2).
   - Without this, the join's pins would go into an identity of another enrolment. The settle's forward rule would then
     disagree with the direct pin write.
6. **`sk_prejoin` is never replaced** (M2R-5): `PrejoinWriter.check`, at step one and again inside the commit, refuses
   with `prejoin_exists`.
   - The exception is a record that is this very join's, from a try that died before its commit: the same cloud key,
     this profile's vault id **and the same plaintext** (one decrypt with the cloud key). Its retry is allowed, so
     "joining not finished" still works. RR-5: key and vault id alone also matched an earlier, completed join's record
     once a backup of that vault was restored; the plaintext tells them apart, and replacing a record with its own
     plaintext loses nothing. A retry after the local accounts were edited between the two attempts is refused too
     (`prejoin_exists`; M6 offers export or delete). A join id was not used: it would need a member the popup's cleanup
     carries, and a retried enrolment makes a new identity anyway.
   - The write is read back (M2R-14's option). After the join it is the only complete copy of that vault, so a dropped
     write fails the join.
7. **The restored identity's state** (M2R-7): `sk_sync_cfg` mirrors the identity's state (a plain `state` member, not
   secret). It is "pending" when written, since the copy is written before init or complete (§2.5 D4), and kept for the
   same device on later writes. M3 calls `cfg.setState` whenever it changes the identity's state, and a restore takes it
   from there.
8. **Restore against "turn sync off"** (M2R-6): `restoreIdentity` writes with `putIfAbsent`, which re-checks under the
   identity lock that there is still no identity and the copy is still there. `turnOff` removes its storage.local keys
   and the identity under that same lock. Lock order: vault → identity, never the reverse; `settle()` takes the vault lock
   and is never called under the identity's.
9. **Guard answers are bound to what was reviewed** (M2R-11):
   - `MergeBlocked.seen` holds a SHA-256 of each blocking id's remote entry as it came, never its content, and the answer
     must carry it back.
   - A changed version stops the merge again, with the new digests.
   - "Keep mine" keeps this device's content and life, so an entry in its trash stays in the trash (R24). Its content
     fields come from a spread, so fields added later (YubiKey's `kind`/`ref`, M2R-17) are kept.
   - `secretChanged` covers entries in this device's trash too (R23, now tested).
10. **The rest of the first round's decisions stand**, unchanged:
    - the size check's revision (over-measures by at most 15 bytes);
    - the trash/erase exemption judged by what the edit did;
    - C13 (5000 at add, 50 000 at read; docs/security/local-vault.md's downgrade note is the doc owner's);
    - the join's added mode dedupes against the cloud's live accounts;
    - the join writes `sk_prejoin` and `sk_sync_cfg` inside its transact;
    - `capPrevious` refuses with `cleanup_pending` while a cleanup is pending;
    - the records are skipped on a mirror-only cleanup;
    - `sk_sync_cfg` is moved without being parsed (M1's AAD and label repeated and tested);
    - the element access in `sync-flows.ts`;
    - `"superseded"`;
    - the R8 kinds;
    - `maxSeenVersion` as a parameter;
    - the `cloud_restore` event kind;
    - the remote re-parsed (`untrusted`);
    - `reachesLocal` stricter than the 64-entry exception. The reviewer accepted this (M2R-19). M6 offers "rejoin from
      the cloud" for `needs_password` + `discontinuous`.
11. **The `secK*` text** is `scripts/i18n/m2.py`, in the patch now that the popup-only catalog is merged. Apply the patch,
    then run `python3 scripts/messages.py` (`_locales` is generated and not in the patch).

    | Kind | Recorded by |
    |---|---|
    | `sync_on` | `SyncFlows.commitJoin` |
    | `sync_off` | `SyncFlows.turnOffSync` |
    | `identity_restored` | `SyncFlows.restoreSyncIdentity` |
    | `keys_adopted` | `SyncFlows.commitKeys` when its caller passes `record: "keys_adopted"` (M3 for R2/R3/R6) |
    | `device_approved`, `device_revoked`, `history_cleared` | reserved for M3/M6 (network flows) |
    | `prf_*`, `oath_*` | reserved for the YubiKey features |
12. **RR-6, a residual the design keeps: `adopted_back` trusts the identity in IndexedDB.** Not fixed; documented here.
    - What it is: IndexedDB alone rolled back (a vendor's sync of a stale copy, an old copy of the identity database) to
      a state whose `adopted` is an older bundle B5, while storage.local holds this device's later commits (B6, B7). If
      the server then serves B5 (a replay, or a PITR that happens to coincide), M1's GM2-5 rule takes B5 for "the
      bundle this device last committed" and adopts it back at once (no R3 question). `commitKeys` writes it: its
      stale check passes (M1 judged it against the stored keyring), and its `adopted_back` re-check reads the same rolled
      back identity. The newer recovery key and password stop opening this device. Without the adopted digest, the
      same input is `keys_behind`. `test/regression/m2-rereview.test.ts` "RR-6" pins this behaviour.
    - Who can cause it: only a rollback of IndexedDB on its own, plus the server serving exactly that older bundle. Anyone
      who can write the extension's IndexedDB can write its storage.local keyring as well, so the guard was never a
      boundary against them. It is the GM2-5 rule's exposure: that rule exists because storage.local can roll back on its
      own; the mirror case (IndexedDB rolled back on its own) turns it the other way.
    - Why not fixed here: the reviewer's fix, `adopted.from` (the digest of the keyring a commit replaced, and an adopt-back
      only when the local keyring is exactly that one), changes M1's `AdoptedRecord` format. The brief said not to change
      it. The cheap alternatives I looked at either contradict §3.9 D8's text or need the same format change:
      - a copy of the last landed pins in `sk_sync_state`, taken by maximum with IndexedDB's, would let storage.local
        testify when IndexedDB rolls back. But D8 says not to keep a second, authoritative pin copy in storage.local, and
        a maximum is close enough to that to be the design owner's call;
      - comparing the local keyring with `adopted` alone cannot tell "storage.local behind" (GM2-5) from "IndexedDB
        behind" (RR-6): both read as "local keyring ≠ adopted".
    - For the design owner (§9): accept the residual and say so in §3.9 R1, or choose `adopted.from` (an M1 format
      change and a new vector) or the storage.local maximum (a D8 text change).
13. **RR-10: `noSync` keys on `sk_sync_cfg` only, and that stays.** In `cfg_missing` with a readable vault (a turn-off
    that died between its two halves, or a vendor that dropped `sk_sync_cfg` alone), the six Phase 0 operations run.
    - That is right for the profile: sync is off as far as its own data goes, and a refusal there would leave the user
      with no way to change the password at all. The harm the reviewer describes needs a later round to adopt the
      identity's `adopted` back over the change, and that round must not happen.
    - Refusing on the identity as well would put an IndexedDB read (the identity store) on the service's path, which
      every context, the popup included, carries. That breaks the popup module rule (§3), so it is not small.
    - **The rule, in M3's hand-off (§7 item 11)**: `cfg_missing` with a readable vault is an unfinished turn-off. M3 never
      runs a round or signs there. It finishes the turn-off (`turnOffSync`), or M6 re-enrols. A copy of the device key
      cannot be re-created from the non-extractable identity.
14. **RR-11: the settings page's text for `sync_on` and `cleanup_pending`** is implemented now, in the settings page's
    own error helper (`options/shared.tsx` `errText`, a `PAGE_ONLY` table), with four strings in `scripts/i18n/m2.py`.
    - It does not go in `src/ui/errors.ts`, because the popup carries that table and its catalog would carry the keys.
    - The popup is byte for byte unchanged (55 069 bytes gz). The full zh_CN catalog is 10.4 KB of its 12 KB gate.
    - `prejoin_exists` and the other sync codes are M6's (their screens do not exist yet). `sync_on`'s text points to
      "the sync settings", which M6 provides. M5 must not ship turning sync on before that section exists.
15. **RR-12, for the design owner: the first upload's "in sync" pins** (§3.1 rev. 13, M3's code; nothing in M2).
    - Steps 4–5 run before `sk_sync_cfg` exists, so a Phase 0 key operation in another tab is not refused there.
    - The text should require M3 to build `init`'s bundle from the keyring read **after** step 5 (sync on, so the Phase 0
      operations are refused from then on).
    - Before writing the "in sync" pins (after 201, or after the `GET /v1/keys` recovery), M3 checks that the local
      keyring is still the one it sent. If not, it treats the result as an ordinary round.
    - The truncation itself is a service method with `noSync`.

## 5. M1 changes (authorised)

From §0.0i "M1 code changes" 1–4, as in the first round:
- "the same content" includes `adoptedDigest`;
- the adopt-back;
- the remote first when the pin differs, and `reachesLocal`;
- `pin_ahead`.

From the review (authorised for M2R-2 and M2R-4):
- **`presend.ts`**:
  - `needs_adoption` in the GM2-5 state only for what publishes or hands out a bundle (`publishesBundle(op) ||
    !allowedWhileKeysBehind(op)`, so the repair waits too). Everything else goes ahead as in `keys_behind`, so
    revocation is never blocked.
  - A wrong (old) password there reads `password_changed_elsewhere`: the server's wrap is this device's own newer one.
  - New `published()` and the `Published` type.
- **`capability.ts`** (new): `CommitBasis`, `KeysToCommit`, `issue`, `keysOf`.
- **`bundle-eval.ts`**: the `adopt` verdicts are registered (`issue`), with no change of shape. New `Adoption` type.
- **`index.ts`**: exports `published`, `Published`, `Adoption` and `CommitBasis`. It does not export `issue` or `keysOf`.

From the re-review (authorised for RR-1 and RR-2):
- **`capability.ts`**: `KeysToCommit.base` (the local keyring judged, or null); `issue` keeps a deep-frozen structured
  clone of the bundle and of `base`, and copies of the VKs.
- **`bundle-eval.ts`**: both `adopt` verdicts are issued with `base: i.local`.
- **`presend.ts`**: `preSendCheck` keeps a copy of its `local` beside each `VerifiedServerBundle` (a module `WeakMap`), and
  `published()` issues with it as `base`.
- No shape change of any verdict or result; vectors, contract and `check_consistency.py` unchanged.

## 6. Existing tests that changed, and why

Relative to main before M2 (unchanged since the first round):

| Test | Change | Why |
|---|---|---|
| `test/unit/security-log.test.ts` (4 lines) | stored `v: 1` → `v: 2`; the "newer" example `v: 2` → `v: 3` | R8: every write is version 2 |
| `test/unit/security-notice.test.ts` (3), `test/e2e/security-log.spec.ts` (1), `test/e2e/security-helpers.ts` (type only) | the "newer" example `v: 2` → `v: 3` | same |
| `test/unit/service.test.ts` (1 line) | `toMatchObject({ v: 1, failed: 1 })` → `v: 2` | same |
| `test/unit/sync-crypto-hygiene.test.ts` | "no page, worker or other layer imports it yet" → the M2 importers allowlist (each really imports) | M1's rule ended by design with M2 |
| `test/unit/sync-crypto-adoption.test.ts` | the exhaustive loop gains `reachesLocal` (384 → 768); `adoptedBack: false` in the old `sameVkVerdict` loop; the model's unlock order. **New in this round**: an added exhaustive `sameVkVerdict` loop over `adoptedBack` and `previousCovers` (R31) | new facts |
| `test/unit/sync-crypto-adoption-crypto.test.ts`, `-presend`, `-review`, `-enroll`, `-vectors`, `test/helpers/sync-vectors.ts` | `adoptedDigest: null` (or T-02's model digest) | the new required input |

No assertion was weakened. The two `toEqual({kind: "adopt", …})` cases in `sync-crypto-adoption-crypto.test.ts` still
pass unchanged, because the registered verdicts keep their shape. `enable-crash.test.ts`, `fault/store.test.ts` and the
other baselines the reviewer listed are byte-identical to main.

Tests of M2's own that changed in this round:
- The reviewer's probes became `test/regression/m2-review.test.ts`. Each probe now asserts the fixed behaviour.
- `m2r-crash-ext` was folded into the shared `test/helpers/m2-crash.ts`. It runs as `m2-crash-matrix` (single faults and
  the lying disk; residual classes listed, everything else hard) and the two `m2-crash-double-*` files.
- The `restoreIdentity` case in `m2-sync-local` now records "enrolled" with `cfg.setState` before restoring (M2R-7).
- `read-budget-sync`'s first-open-after-applyRemote case went from "a full cleanup, pinned ≤ 60" to "≤ 4, the same keys".

Relative to main with M2 merged, in the re-review round. No refusal reason changed: the stale check runs after the other
checks, so every test that expected `discontinuous` or `different_vault` still gets it. These assertions changed, each
for a new member, and none was weakened:
- `test/unit/sync-crypto-m2.test.ts`, two cases: `keysOf(…)` `toEqual` gains `base` (the local keyring judged, RR-1), for
  an R2 adoption and for a `published()`.
- `test/regression/m2-review.test.ts` PROBE-1: `pendingPins` `toEqual` gains `deviceId` and `prev` (RR-3, RR-4).
- `test/unit/m2-sync-local.test.ts`, "the pins catch up": rewritten for the new copy's members and rules. The old cases
  are all kept: one each for begin, commit, apply, drop, overlay and keep. The "backward" case now begins its copy
  before the pins move on, which is what "backward" is under the new rule. The "no readable keyring" case now also
  asserts the overlay (RR-9). New cases: RR-3, RR-4, RR-7.
- `test/helpers/m2-crash.ts`: "pins behind after the settle" is no longer in `LIE_RESIDUAL`, so it now fails a row even
  on a lying disk (RR-7). Two Published operations are added. The `m2-crash-double-other` filter leaves them to a third
  file, `m2-crash-double-published`.

## 7. M3 hand-off checklist

The first review's list (M2-REVIEW "M3 hand-off checklist"), with the re-review's nine corrections (M2-REREVIEW
"Corrections to the M3 hand-off checklist") folded in, and updated with what M2 now does.
1. **Pins**: call `syncLocal.settlePins()` (or `status()`) before every adoption or pre-send decision, and before the
   unlock decision with sync on (`unlockWithSync`). Do it in the service worker or the settings page, **never on the
   popup's open or unlock**: the popup does not load `pins.ts`, and its unlock has one read of headroom (7 of 8).
   - Budget: one storage.local read and one IndexedDB read in the steady state (§3).
   - The pin fields (`adopted`, `vaultId`, `maxSeenKver`) change only through `setPins`, which counts the write
     (`pinCount`). `identity.update` is for state, maxSeenVersion and D8's forward `vkId` after a settle. A pin changed
     through `update` would let an older pending copy look current (RR-4).
   - Feed M1 the settled `adopted`, `maxSeenKver`, `vaultId` and `vkId`.
   - After a settle the pin is not behind a landed commit, so PROBE-15's `remoteRejected: auth_without_password` no
     longer occurs. Without a settle it would.
   - Never call it while holding the vault lock.
2. **Commit only on an M1 capability**:
   - `commitKeys({keys})` with the verdict object M1 returned, or `published(...)` after the server accepted.
   - A capability is bound to the local keyring M1 judged (RR-1). `bad_state("stale")` means something committed since
     it was issued: drop it and evaluate again. Never retry it, unless it is the retry of a commit that landed.
   - Never alarm on a `commitKeys` refusal. M1's verdicts are what the user sees.
   - The capability is M1's own frozen copy, but do not mutate objects handed to M1 after its verdict anyway (RR-2).
   - `needs_new_password` carries nothing and cannot be committed. Commit R3 only on `unlockWithSync`'s `adopt`.
   - The old VKs to hold are carried by the capability.
   - A capability is usable only in the JS context that made it (M1-19).
3. **Remote vaults**: decrypt only with the current VK, and check `envelope.vkId` = the pinned `vkId` and the vault id
   before `applyRemote` (R5, I6). A previous-VK version is used only by "find accounts".
4. **The guard**:
   - run `guardMerge` before `applyRemote`;
   - on `MergeBlocked`, keep nothing of the remote (C1);
   - [Apply] re-pulls and passes `{seen, accept}` (or `keepMine`) from the `MergeBlocked` the user reviewed;
   - keep a reviewed answer in memory only: `seen` is an unsalted SHA-256 of the remote entry, secret included;
   - the danger-banner rule as in §4.4 D6.
5. **The outbox**: set `SyncPort.afterCommit` (§4.7, D2). It runs inside the vault lock: no network, no cleanup, and no
   identity writes other than in the vault → identity lock order. On push success, apply the `lastSynced` CAS.
6. **`sk_sync_state`**: give M3's writers one helper that does the read-modify-write under the vault lock and keeps the
   members it does not own (`pendingPins` included), plus a source rule that nothing else writes the key.
   - M2's writers all follow it now: the clear, `pins.begin`, the pending clear, and `turnOff` (since RR-3 under the
     vault lock too).
   - Never derive sync state from events (I12).
   - The recovery hook and every key commit or join already clear `lastSynced`.
7. **D8**:
   - forward: `identity.update` with the `vkId` from `pinAfterUnlock`, after a settle (only `vkId`: the other pin fields
     go through `setPins`, item 1);
   - `pin_ahead` → `needs_password`, in the R4 order, and one password adopts;
   - `pin_ahead` + `discontinuous` → offer "rejoin from the cloud" (M2R-19).
8. **`identity_missing`**: `restoreSyncIdentity({maxSeenVersion})`, only once unlocked. The identity comes back in the
   state `sk_sync_cfg` mirrors.
   - **Call `syncLocal.cfg.setState(state)` whenever the identity's state changes** (after init or complete is
     confirmed, and on `rejected_by_server`).
   - **Confirm every restored identity's state with the signed status query**, not only a "pending" one. The copy can be
     one transition behind (a crash between `identity.update` and `cfg.setState`).
9. **The first upload (§3.1, rev. 13; RR-12)**:
   - the `createdAt` truncation goes through a service method with `noSync`;
   - build `init`'s bundle from the keyring read after `sk_sync_cfg` is written (step 5);
   - before writing the "in sync" pins (after 201, or the `GET /v1/keys` recovery), check that the local keyring is still
     the one sent; if not, treat it as an ordinary round.
10. **The rotation (§3.8 P1)**: check `store.loadView().cleanup === "none"` before calling `capPrevious` in memory (or
    finish the cleanup first). applyRemote no longer leaves a marker, so this holds after a sync.
11. **`cfg_missing` with a readable vault** (RR-10): an unfinished turn-off. Never run a round or sign there. Finish the
    turn-off (`turnOffSync`), or have M6 re-enrol. The Phase 0 operations run there (§4.2 item 13).
12. **Pre-send**: `preSendCheck` and its builders run in one JS context.
    - In the GM2-5 state revoke, reject, rename, `clear_history`, fork and delete go ahead; publishing and handing out
      wait for the adopt-back.
    - A revoke typed with the old password there returns `password_changed_elsewhere`: M6 asks for the newer password,
      which is the device's own.
13. **R6**: the engine test for `paused_newer` on a v2 remote, including the F6a walk.
14. **D7**: `applyRemote` throws `too_large` past 50 000 entries. Set the status, and do not retry every round. An
    over-size merge is committed; only the upload is paused.
15. **The Phase 0 key operations**: refused with `sync_on` while sync is on (§4.1). The settings page already says what it
    means (RR-11: `options/shared.tsx`), and `cleanup_pending` too. M6 routes the user to §3.6–§3.8 and adds the text for
    `prejoin_exists` and the other M2 codes (M2R-15). **M5 must not ship turning sync on before M6's sync settings
    exist**, since the `sync_on` text sends the user there.
16. **The join**:
    - settle first (a stale pending copy could make `commitJoin` refuse with "not the joining device's");
    - the identity must be there and be the joining device's: replace it per §3.5 before a "rejoin from the cloud" into a
      new vault id;
    - pass `answer` for a merged-mode join the guard stops;
    - `prejoin_exists` → M6 asks the user to export or delete it ("Advanced");
    - `complete` after `commitJoin`, then `cfg.setState("enrolled")`.
17. **The marker**: done. applyRemote writes none (§0.0i item 2 rev. 12), and the first open after a sync reads 4.
18. **The popup**: the module-graph rule (`m2-source-rules`) fixes what of `core/sync` the popup loads. A new import there
    fails a test, and that list is the one to extend deliberately, measuring check-dist.

## 8. The review, finding by finding

### 8.1 Findings

| Finding | Done | Tests |
|---|---|---|
| **M2R-1** (High) stale `adopted` after a lost pin write | **Fixed**: `pendingPins` in the transact's clear write, `settle()` before decisions (§4.2 item 3) | PROBE-1, PROBE-2, PROBE-2b/15 flipped (`m2-review`); `m2-sync-local` pins block; crash matrices: "pins behind after the settle" never, the D8 window reached in every key-commit op |
| **M2R-2** (Medium) revoke refused with `needs_adoption` | **Fixed** in `presend.ts`. Unlike the reviewer's literal fix, the repair still waits (`publishesBundle(op) ‖ !allowedWhileKeysBehind(op)`) | PROBE-3 flipped; `m2-local-tail-lost` (revoke, reject, reject_all, clear_history go ahead; 6 publishing/handing-out ops wait); `sync-crypto-m2` |
| **M2R-3** (Medium) Phase 0 key ops with sync on | **Fixed** by blocking with `sync_on` (§4.1) | PROBE-4 (all six, wrong passwords too, nothing recorded), the in-transact race test |
| **M2R-4** (Medium) no continuity in `commitKeys` | **Fixed** with M1 capabilities, continuity, pin reachability and the lock-out guard (§4.2 item 4) | PROBE-7 flipped; `m2-service` 6 cases; `sync-crypto-m2` |
| **M2R-5** (Low) a second join replaces `sk_prejoin` | **Fixed** with `prejoin_exists` (own retry allowed) | PROBE-5 flipped; the retry test; the other-vault-same-key case |
| **M2R-6** (Low) restore racing turn-off | **Fixed** with `putIfAbsent` and a locked `turnOff` | PROBE-6 flipped (`off`, the restore refused) |
| **M2R-7** (Low) restored always `enrolled` | **Fixed**: the state is mirrored in `sk_sync_cfg` | PROBE-13 (pending, enrolled, rejected_by_server) |
| **M2R-8** (Low) the popup rule matched names | **Fixed**: the rule is now on the module graph, an exact set | `m2-source-rules`; mutant N95 (the reviewer's bypass) killed |
| **M2R-9** (Low) the LANDED path pinned outside the lock | **Fixed**: the pins are written inside the callback | the landed-join retry test (the pins written by the retry) |
| **M2R-10** (Low) applyRemote's marker | **Fixed** (Q1) | PROBE-9 flipped; `read-budget-sync`; `m2-service` |
| **M2R-11** (Low) guard answers bound by id only; R22–R24 | **Fixed** with digest binding; R23 kept as is (it was right) and tested; "keep mine" for the trash fixed | `m2-service` M2R-11 and R23/R24 tests |
| **M2R-12** (Low) test gaps R02, R03, R06, R31 | **Fixed** | R02 (cloud restore vault id), R03 (prepareJoin), R06 (`createRuntime`'s records move both), R31 (steady state with a real digest; the exhaustive `adoptedBack` loop); R20 equivalent (documented). Not done: pin-loss and tail-loss events in M1's T-02 fact model. The defect is M2's write order, and the crash matrices' settle invariant and `m2-local-tail-lost` test it where it lives |
| M2R-13 (Info) the hook's read fails a recovery closed | Kept (Q2) | PROBE-8 kept |
| M2R-14 (Info) a lying disk reaches three new writes | `sk_prejoin` is read back. The other two (a record rewrite, the pre-merge snapshot) are the A4R-10 residual, listed in `LIE_RESIDUAL` | the lying-disk rows: "no sk_prejoin" never occurs |
| M2R-15 (Info) error texts | M6 (hand-off item 13) | — |
| M2R-16 (Info) 5000 at add time | unchanged; docs/security/local-vault.md's note is the doc owner's | — |
| M2R-17 (Info) field lists | "keep mine" now spreads this device's entry. `addAccountsFrom` keeps its field list (Phase 0 code shared with `importBackup`); YUBIKEY-DESIGN §2.11 should list it | — |
| M2R-18 (Info) a guarded rejoin cannot be answered | **Done**: `JoinInput.answer` | PROBE-14 (answered with keep mine) |
| M2R-19 (Info) `reachesLocal` | accepted | — |
| M2R-20 (Info) costs | measured (§3) | — |
| Q1 | drop applyRemote's marker: done | — |
| Q2 | keep as built | — |
| Q3 | capabilities, continuity and the lock-out guard: done | — |

### 8.2 The extended crash matrix

The ops are the review's five plus the re-review's two Published ones (this device's own new recovery key and
rotation). They are rebuilt on M1 capabilities and on a real steady state:
- the local keyring is the bundle's;
- the cloud restore adopts a later key state;
- the join runs with the joining device's own fresh identity.

The rows, about 1300 in all:
- **Single faults** (`m2-crash-matrix`): before, after and lie, with and without a restart.
- **Double faults** (`m2-crash-double-keys`, `-other`, `-published`): before and after, then a restart that dies at its
  own write 1–6.
- **The settle itself** (`m2-crash-settle`, from the re-review): a Published commit whose IndexedDB pins were lost, then
  `settlePins` dying (or lied to) at each of its writes, then a second dying settle; 27 rows, all hard, the lying disk
  included. Also three contexts at once with one IndexedDB refusing writes.

The invariants are hard everywhere except on the lying disk. There, only the classes in `LIE_RESIDUAL` may appear: the
A4R-10 residual and the GM2-5 shape of a dropped pointer write. Every other violation fails the row. "No sk_prejoin"
never appears, and since RR-7 neither does "pins behind after the settle" (it was removed from `LIE_RESIDUAL`).

New invariant: whenever the new keys are committed, the settled identity's `adopted` is the new bundle's. The test also
checks that the window where the raw IndexedDB pins lag is reached (`rawBehind`), so the invariant is not vacuous.

### 8.3 Mutation results

**After the re-review** (`scratchpad/m2/scripts/mut3.py`, results in `scratchpad/m2/mut3-results.json`): **170 mutants,
164 killed, all by tests (none by the type checker alone), 6 equivalent.**

| Group | Mutants | Killed | Equivalent |
|---|---|---|---|
| A: my first round's 45 | 45 | 45 | — |
| B: the first reviewer's 31 | 31 | 30 | R20 |
| C: my second round's 52 | 52 | 49 | N15, N51, N61 |
| Q: the re-reviewer's 25 (`m2rr-mut/mutrr.py`) | 25 | 23 | Q08, Q22 |
| S: new, one or more per re-review fix (S01–S18) | 17 | 17 | — |

- **Ports.** Where the code moved, the mutant was re-pointed at the same rule's new line: M04, M29 (`setPins` with
  `pinCount`), M30, N61 (`turnOff` under the vault lock), R05, R21, Q05 (`pins.begin(pendingFor(…))`), N02–N09 and Q02,
  Q06, Q07, Q16 (the new `view`/`forward`), N19, N20 (`base` in `issue`), N24, Q38 (the copying `issue`), N25, Q14 (the
  join's identity check), N50, N51, N53, Q17 (the plaintext `check`).
- **The equivalents**:
  - R20 and N61 as before;
  - N15 (the cloud restore's "only opened keys"): RR-1's stale check subsumes it. Every capability that is not
    `opened` has a local keyring as `base`, and a cloud restore has no stored keyring;
  - N51 (`sk_prejoin`'s vault-id condition): the plaintext comparison subsumes it, because the vault id is in the
    plaintext;
  - Q08 (continuity skipped for `adopted_back`): `adopted_back` is same-VK only, M1 ran the same check against the same
    `base`, and RR-1 refuses a stale one first;
  - Q22 (`enableMasterPassword`'s check outside its transact): sync needs a master password, so a device-key vault
    never has sync on, and the race cannot happen.

**The first round** (`mut2.py`, `mut2-results.json`): 128 mutants, 126 killed, all by tests, 2 equivalent.
- **The first full run**: 124 killed. Two survivors were real gaps, and each now has a test:
  - N09 (an unreadable keyring dropped `pendingPins` instead of keeping it);
  - N47 (`newRecoveryCode`'s check inside its transact).
- Two mutants (N12, N13) were killed only by tsc. They were rewritten so they type check, and tests then killed them.
- **Ports**:
  - group A: M01 is inverted (applyRemote with a marker again: killed); M21 moved to `pins.begin`; M30 and M03 follow
    the new code;
  - group B: R01 targets `checkPins`' stored-keyring check; R05 and R21 the `pins.begin` lines; R14 the new `turnOff`;
    R22 the bound answer; R24 the trash case.

Documented equivalents:
- **R20**: today's `addAccountsFrom` already keeps every live local account.
- **N61** (`turnOff` not holding the identity lock across both removes): `putIfAbsent`'s re-check under the lock makes
  every interleaving consistent. The removal of the identity itself takes the lock.

### 8.4 The re-review (`docs/audit/internal-reviews/M2-REREVIEW.md`), finding by finding

| Finding | Done | Tests |
|---|---|---|
| **RR-1** (Medium, blocks M3) a stale or replayed capability writes an older keyring | **Fixed**: `base` in every capability; `commitKeys` refuses `bad_state("stale")` unless the stored keyring is `base` or the bundle's (§4.2 item 4); M2-NOTES' false "replay harmless" corrected | `m2-rereview` RR-1: the R2 race and the Published replay flipped (stale, nothing written, the new code and password stand); the landed retry accepted; a cloud restore only with a null base |
| **RR-2** (Low) the capability's bundle was the caller's object | **Fixed**: `issue` keeps a deep-frozen clone of the bundle and `base`, and copies of the VKs | `m2-rereview` RR-2 (a mutated bundle and a wiped VK after the verdict change nothing written); the brand test |
| **RR-3** (Low) turnOff without the vault lock | **Fixed**: `turnOff` under the vault lock. A pending copy is bound to its identity (`deviceId`). `commitJoin` needs the joining device's identity | `m2-rereview` RR-3 (a commit in flight lands first, then off, no copy left; a commit after turn-off leaves a copy no fresh identity takes) and RR-3b (the join lands first; a join prepared before turn-off is refused); `m2-sync-local` RR-3 |
| **RR-4** (Low) "forward" by `maxSeenKver ≥` | **Fixed**: the copy carries `prev` = the identity's `pinCount` at begin; forward = no pins yet, a higher kver, or nothing pinned since. The capped-publish edge is fixed by the same rule | `m2-rereview` RR-4 (with Q36); `m2-sync-local` RR-4 (the equal-kver tail loss, A → B → A, the capped publish, a higher kver, `maxSeenVersion` ignored) |
| **RR-5** (Low) the sk_prejoin own-retry exception too wide | **Fixed**: the exception needs the same plaintext too (one decrypt) (§4.2 item 6) | `m2-rereview` RR-5 flipped; Q17 (a damaged record is never replaced); the first round's retry test still passes |
| **RR-6** (Low) `adopted_back` trusts IndexedDB alone | **Documented** (§4.2 item 12). `adopted.from` would change M1's `AdoptedRecord`; the cheap alternative contradicts D8's text. For the design owner | `m2-rereview` "RR-6" pins the residual |
| **RR-7** (Low) the pending copy cleared over a lying IndexedDB | **Fixed**: `commit` and `settle` read the identity back before clearing | `m2-sync-local` (a lying IndexedDB keeps the copy); `m2-crash-settle` (lie rows hard); the matrices (the class removed from `LIE_RESIDUAL`) |
| **RR-8** (Low) the reviewer's surviving mutants | **Fixed**: one test each for Q02, Q09, Q10, Q11, Q13, Q14, Q17, Q19, Q21, Q36, plus Q18 and Q20 (equivalent today, cheap to pin). Q08 and Q22 stay equivalent | `m2-rereview` "RR-8"; `m2-sync-local` (Q02, Q18) |
| **RR-9** (analysis) no overlay without a keyring | **Fixed**: laid over when it moves forward, nothing written | `m2-sync-local` (the lost-keyring case asserts the overlay) |
| **RR-10** (analysis) `noSync` keys on `sk_sync_cfg` only | **Decided** (§4.2 item 13): it stays; `cfg_missing` with a readable vault is an unfinished turn-off that M3 finishes and never runs a round in | — |
| **RR-11** (Low) "unexpected error" for `sync_on` | **Fixed** in the settings page only (`options/shared.tsx`), `cleanup_pending` too; the popup unchanged byte for byte (§4.2 item 14) | `m2-source-rules` RR-11 (both languages; none of the keys in the popup's catalog) |
| **RR-12** (analysis) §3.1's "in sync" pins | **Documented** for the design owner (§4.2 item 15) and M3 (§7 item 9) | — |

Mutants of this round: §8.3's run covers my 128 (ported), the reviewer's 25 (`m2rr-mut/mutrr.py`, ported where the
code moved) and 17 new ones (S01–S18, one or more per fix).

## 9. Still open (not M2, or deferred by the design)

- **M3**:
  - the engine and FakeServer;
  - R6's engine test;
  - the danger-banner rule;
  - D7 at 50 000 (`too_large`; untested at that size here for cost);
  - the outbox writer;
  - the first upload's local half per revision 13, with RR-12's check (§7 item 9);
  - the `sk_sync_state` writer helper and its source rule (§7 item 6).
- **M5**: building `SyncLocal` and `SyncFlows` in the service worker and the settings page; the identity's IndexedDB
  (`IdbKV(IDENTITY_DB)`).
- **M6**:
  - the Lost screen's cloud restore;
  - error texts for `prejoin_exists`, `too_large_for_sync`, `review_needed`, `different_vault` and `too_large`
    (`sync_on` and `cleanup_pending` have the settings page's text now, RR-11), and the sync settings that `sync_on`'s
    text points to;
  - the identity_missing UI;
  - "rejoin from the cloud";
  - `startOver` and `restoreBackup` with sync on (§0.0i item 11: the cloud restore is offered first; neither is blocked by
    item 18, which covers key operations on an existing vault).
- GM2-2(b), GM2-8, GM2-9, GM2-6/P-9, A4R-3's remainder and A4R-10: unchanged.
- The design owner:
  - (revision 13 took item 18's rule and the first upload's local half);
  - §3.13's two Q2 notes and the GM2-8 line;
  - docs/security/local-vault.md's 5000 note (M2R-16);
  - the format and protocol additions, for §2.5, §4.1 and the error list:
    - `sk_sync_cfg.state`, a plain mirror of the identity's state (§4.2 item 7);
    - `sk_sync_state.pendingPins` (item 17), and the rule that every writer of `sk_sync_state` keeps the members it does
      not own and does its read-modify-write under the vault lock;
    - the new service codes `sync_on` and `prejoin_exists`;
    - `commitJoin`'s new refusal of another device's (or another vault's) identity. M3/M6 must replace the identity
      before a "rejoin from the cloud" into a new vault id (§4.2 item 5).
  - after the re-review:
    - the identity record gains `pinCount` (§4.2 item 3), and `pendingPins` gains `deviceId` and `prev`;
    - §0.0i item 16: capabilities are bound to the local keyring M1 judged (`base`, `bad_state "stale"`) and carry M1's
      frozen copy (RR-1, RR-2);
    - §0.0i item 17: the forward rule by `pinCount`, the read-back, the identity binding, and the overlay without a
      readable keyring (RR-3, RR-4, RR-7, RR-9); "turn sync off" takes the vault lock;
    - §3.5: `sk_prejoin`'s own-retry exception needs the same plaintext (RR-5);
    - §3.9 R1: RR-6's residual and the choice of fix (§4.2 item 12);
    - §2.5 `cfg_missing`: an unfinished turn-off, never a state to run rounds in (RR-10);
    - §3.1: RR-12's check (§4.2 item 15).
