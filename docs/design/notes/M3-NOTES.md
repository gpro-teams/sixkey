# M3 implementation notes (M3-NOTES)

Date: 2026-10-17; revised 2026-10-18 after the review (`docs/audit/internal-reviews/M3-REVIEW.md`, revision 2 of this patch), the re-review
(`docs/audit/internal-reviews/M3-REREVIEW.md`, revision 3), the third review (M3-R3-REVIEW, revision 4: §0b), the fourth review
(M3-R4-REVIEW, revision 5: §0a) and the fifth (M3-R5-REVIEW, "MERGE AFTER FIXES"; revision 6, a very small
delta: §0), against
SYNC-DESIGN revision 20 (§0.0t: the orphan list, demote never drop, the merge-only outbox, parking, `vault_lost`) and
contract revision 18 (unchanged since). What M3 built (SYNC-DESIGN §9, M3 row; §4 the engine; the client halves of §3),
against which tests, the decisions the design left open, and what M5, M6 and the design owner must know. SYNC-DESIGN.md is
not edited here; §4 lists what its owner should take into the text. §A describes the outbox and the orphan list as built,
for readers outside the project; §B lists what is known and left open for M5 and M6. Paths under `scratchpad/` (the
mutation runners, their results and logs) name the private working copies the runs were made in; they are not part of
the repository. The reports of the third, fourth and fifth reviews were not retained either; §0, §0a and §0b record
their findings and what was done about each.

---

## A. The outbox and the orphan list: how they work (for readers outside the project)

This section describes the design as the code implements it, without the history of how it got there. The design text
is SYNC-DESIGN §4.7; the code is in `extension/src/core/sync/local/` (the records, the recovery hook, the turn-off) and
`extension/src/core/sync/engine/` (the push, the fold, the retirements, the flows).

**The problem.** Sixkey keeps the vault in `chrome.storage.local` as two slots and a pointer, with rolling snapshots.
When the active slot is damaged (a torn write, a disk fault), the store falls back to an older copy. Without sync, that
is the end of it: Phase 0 guarantees the older copy, not the last save. With sync, the last save may exist in one more
place: the outbox, the upload computed at the commit. The rules below make sure that copy is never deleted before its
content is provably in the vault or on the server, and that no older local state is ever uploaded over the server's
newer one without a merge.

**The records** (all in `chrome.storage.local`, none of them vault data):
- `sk_sync_outbox`, the live outbox, written at every commit while sync is on, inside the vault lock. With `lastSynced`
  set it is PUSHABLE: the exact `PUT /v1/vault` the engine would send next, with its base version, the server head it
  was built on, the committed generation's checksum, the upload envelope and a write proof, so a context without the
  key can push it. With `lastSynced` null it is MERGE-ONLY: the committed generation's own envelope text and checksum,
  never pushed. Over the envelope size limit nothing is written and the record already there stays. With sync off the
  writer writes nothing.
- `sk_sync_orphan`, the orphan list `{v: 1, items: [...]}`: outbox records kept when they could not be pushed or the
  local state they belonged to was lost. An entry may carry a `parked` mark `{reason, vkId, at}` (below). A stored value
  that is not a list is read as a list of that one value, everywhere. An entry of a newer record format (`v` above 1) is
  kept and treated as parked; this build never opens, pushes or folds it.

**Who adds to the list** (always an append, never over another entry; each in one storage write, under the vault lock):
1. The storage recovery hook: before any write that makes the active state something other than what was last committed
   (a fallback to the other slot, a rebuild from a snapshot or the mirror, a decrypt fallback, a write over lost data),
   `lastSynced` is cleared and the live outbox is appended to the list, in one write.
2. The demotion: when the locked push cannot send the live pushable outbox (the server answered 409, refused the write
   with the key moved, or is no longer at the outbox's base version and head), the outbox is appended, and the outbox
   and `lastSynced` are cleared, in one write.
3. Turning sync off: the live outbox is moved into the list unless the active slot on disk passes its integrity check and
   its envelope checksum is the outbox's. That test is exact: the store loads the slot the pointer names whenever that
   slot passes the same check, and its recovery (a fallback to the other slot, or rolling back an unfinished key change,
   which also keeps the pointer's slot) runs only otherwise; the turn-off reads it under the vault lock, which every
   writer of the slots holds.

**What the engine does with an entry.**
- Push (any context, with or without the key): a pushable entry is pushed only while the server is at exactly its base
  version and head; a `200` retires it; a server already at base + 1 with that entry's own text (an earlier push whose
  answer was lost) retires it; anything else keeps it. A merge-only entry is never pushed.
- Fold (only in a context holding the vault key, never the popup; at the start of every round, and first in every flow
  that replaces, re-keys or deletes): each entry is opened with the current key or a previous key the keyring lists, and
  its vault id is checked. Each openable entry is clamped (timestamps more than 24 h ahead are pulled back, as remote data
  is) and all of them are merged into one remote that M2's `applyRemote` merges into the local vault in one commit,
  through the deletion guard. A guard block changes nothing: the user reviews, and the answer binds to what was shown.
  An entry this build cannot open now is PARKED with a reason: `key` (a key this keyring does not hold), `schema` (a
  newer schema or record format: update Sixkey), `too_large` (the merge would pass the entry limit). Parked entries are
  retried by every keyed round; the mark is cleared when one folds. Folding never deletes an entry.

**The only ways an entry leaves the list:**
1. Retired by its push (`200`, or found already on the server as above).
2. Retired by the write that sets `lastSynced` at the end of a full round that folded it (the same `storage.local.set`).
3. Retired because its checksum is the active generation's (the vault is that generation).
4. Removed when damaged (it does not parse: there is nothing in it to save).
5. Removed when it belongs to another vault (left over from "start over", which the user confirmed); never pushed.
6. Removed when parked for a key that is provably gone: a full round confirmed the server's key chain and the entry's
   key id is neither the current key nor one the keyring lists (one `orphan_unreadable` notice says how many).
7. Removed by the user ("Advanced"), after confirming the parked entries shown: the delete names their count and their
   checksums, and is refused unless both still describe the parked entries, checked inside the delete's own critical
   section. Never an unparked entry.
8. With sync off, removed by the settings page's local fold once it is in the vault (no network; parked ones stay).
9. Removed by turning sync off when the flow that turns it off reports it folded into the vault first.

**The invariant.** The write that sets `lastSynced` is refused while an unparked entry that this round did not fold is in
the list. So, with two known exceptions (§B items 4 and 6), an unparked entry means `lastSynced` is null, which means
every save until the next keyed round is written as a merge-only outbox, which the next recovery appends again. Parked
entries do not hold sync up.

**Flows that delete the sync records** (turn sync off, remove the sync identity, and the undo of an unfinished
enrolment) fold first. While this context is locked and an unparked entry is left unfolded they refuse (`locked`:
unlock first); with no local vault and such an entry they refuse (`vault_lost`: a cloud restore or a backup first). Then the local
turn-off keeps every entry the flow did not report folded (parked ones, ones appended meanwhile) and moves the live
outbox into the list unless the active slot provably holds it. The undo of a first upload that never reached the server
folds nothing, so it keeps every entry. `sk_sync_orphan` is deleted only when it is empty.

**Joins** (by recovery key or by approval) replace the local vault, so they fold first. While this context is locked
and an unparked entry is left unfolded they refuse (`locked`). The approval join folds again when the confirmation code
is accepted, before it prepares the join, because the page may have been unlocked (or an entry added) since the start.
Over a lost local vault (which the user confirmed) a join goes ahead; entries of the same vault are folded by the first
round with the joined keyring.

**With sync off**, every settings-page unlock runs the local fold (`foldParkedLocally`): it folds every entry it can open
into the vault and removes those, keeps the parked ones, and sends nothing. It refuses with sync on (the round folds).
The parked notice (`parkedSummary` / `readParkedOrphans`: count, reasons, checksums) is shown with sync on or off.

**Locks and bounds.** Every writer of `sk_sync_outbox` and `sk_sync_orphan` holds the vault lock (the `sixkey-vault`
web lock), which the store's own writes and its recovery hook hold too. Each entry is at most the envelope size limit;
one is added per recovery, demotion or turn-off; a keyed round folds every openable one. Nothing ages out by time.

**Not covered here** (see §B): the cases the design still leaves open, and the limits of Phase 0's store that the list
inherits.

## B. Known residuals for M5 and M6 (recorded, not fixed in M3)

Each is a known limit of M3 as it stands; none loses a save the user was told was made, except where the item says so.
The tag in brackets is the identifier its test or note uses.

1. **Entries kept by a turn-off, then a join to another vault** [R4R-12]. **Closed** by SYNC-DESIGN revision 24 (§4.7)
   and M6 (`docs/design/notes/M6-NOTES.md` §12 item 1): an entry of another vault is never removed by itself; the fold parks it
   ("vault"), a locked round neither pushes nor removes it, and only the user deletes it, in the Sync section. Until
   then: parked entries (any join), and unparked ones when the join went ahead over a lost local vault, were removed by
   the first round as "of another vault" without a word.
2. **A join over a lost local vault** goes ahead over the fold's `vault_lost` (the user confirmed replacing the lost
   vault). Entries of the same vault are folded at the first round; entries of another vault fall under item 1.
3. **A guard answer cannot match a fold of an entry stamped more than 24 h ahead** [R4R-6]: the guard digests the clamped
   entry, and the clamp moves with the clock, so an answer given a moment later never matches. The entry stays (no
   loss); the round keeps asking. A fix (digest the raw combination) changes the tie-break that clamping each entry on
   its own gives; a design decision.
4. **A parked entry that becomes readable while in sync and holds nothing new** is folded every round and never retired
   [R4R-9]: an unparked entry beside a non-null `lastSynced`. No data at risk. Fix: retire it in the "nothing to do"
   branch under the same checks as the `lastSynced` write.
5. **One fold over the entry limit parks every entry tried with it** [R4R-10], so a later small save that fits alone is
   parked with them. Kept, not lost; folded once there is room. Fix: fold the entries not parked for `too_large` first.
6. **A lying pointer write on the fold's own commit** [R4R-11] (the disk acknowledges the write and keeps nothing): the
   round's `lastSynced` write can still retire the entry it folded, although the vault it uploaded does not hold it.
   This is Phase 0's store limitation (a lie on the commit point is outside its fault model). Fix: retire through the
   `lastSynced` write only when the reloaded vault is the fold's generation.
7. **With sync off, unparked entries a turn-off kept are not in the parked notice**; they are folded silently at the next
   settings-page unlock (or by the next join's fold, or the first keyed round after sync is turned on again).
8. **Info.** After a downgrade, an older build can push a parked entry of a newer schema when the server is at exactly
   its base and head (the write it was made for); every older build then pauses (`paused_newer`) until it updates.
   The "key provably gone" removal (§A item 6) also matches a key newer than the chain, which needs a point-in-time
   restore of the server past a rotation together with a lost identity.
9. **Defensive code without a reachable failure:** the "Advanced" delete reads the list a second time inside its
   critical section; every writer holds the same lock, so the re-read guards only against a writer that ignores it.
   A parked `key` entry whose key the keyring does list cannot be produced by any code path (the keyring re-wrap drops
   what it cannot open), so the check that removes such entries only when the key is not listed has no failing case.
   The recovery-code join's refusal of a locked fold repeats `prepareJoin`'s own need for the local key, which refuses
   `locked` right after it; it differs only for a lock that lands inside the fold and is lifted before the prepare.
10. **The point-in-time restore fence** (M8): until it exists, a late write after an honest server rollback can replace
    another head for one round (`m3rr-replay` pins the case; the data comes back from the devices).

---

## 0. Revision 6: the fifth review (M3-R5-REVIEW), a very small delta

The fifth review's two test files are adopted (`test/unit/m3r5-review-probes.test.ts`, `m3r5-review-killers.test.ts`).
Its three FINDING tests (R5R-1, -2, -3) pass as plain tests. **Edits to reviewer tests, each marked in the file:**
- `m3r5-review-probes`: a header comment; R5R-3's count-only call gains a cast (the checksums are required in the type
  now; the call still runs as a JavaScript caller's would, and the runtime refuses it).
- `m3r5-review-killers`: a header comment only.
- `m3r4-review-probes`: R4R-8's call passes the checksums (now required; without them the delete would be refused before
  the in-lock re-read the probe attacks); the five recorded probes' titles point to §B instead of §0; a header line.
- `m3r4-review-crash`: the "Advanced" crash test passes the checksums (without them its one write would never run); a
  header line.

| Finding | Severity | Verdict | Code | Tests (and the mutants, §7) |
|---|---|---|---|---|
| R5R-1: the approval join ignored a fold that ended `locked`, and its prepare never folded again: a locked start, an unlock before the code, and a join to another vault lost a kept entry's save | medium | **fixed** (the review's prototype, plus the second fold) | `enroll.ts foldForJoin`: the fold, then `EnrollError("locked")` when it ended `locked` and an unparked entry remains (a lost vault goes ahead). Used by `joinWithRecoveryCode`, `ApprovalJoin.start` AND `ApprovalJoin`'s prepare (with the start's `answer`), so both joins behave alike and an unlock between start and prepare is folded | R5R-1; `m3-rev20` "patch revision 6: the approval join folds again at the prepare" ×4 (a locked start refuses before anything is sent or written; an entry that came after the start; a parked entry that opens after the unlock; locked again at the prepare: refused, cancel and start again folds it); R6-01, R6-02, R6-03 |
| R5R-2: turning sync off still deleted the live outbox: a slot torn during the revoke, seen by no load before the turn-off, lost the save | low | **fixed** | `SyncLocal.turnOff` (M2) moves the live outbox into the list unless the active slot on disk passes `checkGeneration` and its envelope checksum is the outbox's (checked inside the turn-off's lock, never a checksum the flow passes: the tear comes after the flow's load); the rule is `local/state.ts keptAtTurnOff` | R5R-2; `m3-rev20` "patch revision 6: the turn-off and the live outbox" ×2 (an intact slot: the outbox goes; a slot that fails the integrity check with the right checksum field: moved into the list); `m2-sync-local` turnOff (a case added); R6-04, R6-05, R6-06 |
| R5R-3: "Advanced" accepted a count without checksums | low | **fixed** | `discardParked` / `discardParkedOrphans`: `checksums` required in the type and at run time (`Array.isArray`), and the count must agree with them | R5R-3; `m3-rev20` "'Advanced'" (two cases added: a count that disagrees with the checksums, and no checksums); R6-07, R6-08, R5V-10 |
| R5V-10, R5V-16, R5V-17 survivors | — | **killed** | — | the review's killers (adopted) |
| R5V-11 (the second read) | — | **agreed: equivalent under the real lock** | — | §B item 9 |
| Recorded: R4R-6, -9, -10, -11, -12 | low | **recorded** | — | §B (R4R-12 narrowed by R5R-1's fix: §B item 1) |

---

## 0a. Revision 5: the fourth review (M3-R4-REVIEW), a small delta

The fourth review's three test files are adopted (`test/unit/m3r4-review-probes.test.ts`, `m3r4-review-killers.test.ts`,
`test/fault/m3r4-review-crash.test.ts`). **Edits to them, all flagged in the files:** the probes of the five findings
recorded only (R4R-6, -9, -10, -11, -12) run as `it.fails`, marked "RECORDED, not fixed"; the RV4-19 killer's
`toEqual` gains `checksums` (the summary now lists them, R4R-8); a header comment in the probes. Nothing else.

| Finding | Severity | Verdict | Code | Tests (and the mutant per fix, §7) |
|---|---|---|---|---|
| R4R-1: the first upload's undo (`undoLocal`) deleted an unfolded orphan entry holding the only copy of a save | high | **fixed** (the review's fix a) | `SyncLocal.turnOff({folded})` (M2) keeps every entry the calling flow did not report folded (not by the parked mark); `orphanLockedOut` returns `{refuse, folded}` and every flow passes its `folded` to `turnOffSync`; `undoLocal` passes nothing, so every entry stays (the settings page's sync-off fold takes them). Departure 9 is withdrawn | R4R-1; `m2-sync-local` turnOff (**the test that pinned the old rule, rewritten to the new one**); R5-01 |
| R4R-2: `foldForFlow` read the list before loading the vault (a regression of revision 3) | medium | **fixed** | `foldForFlow` loads first (`flows.generation()`, which a locked context can run), then reads the list (M3R-1's order) | R4R-2, R4R-2b; R5-02 |
| R4R-3: an entry appended during the turn-off's revoke was deleted | low | **fixed** by R4R-1's rule | `turnSyncOff` passes the `folded` of its fold, made before the revoke | R4R-3; R5-03 |
| R4R-4: a non-list `sk_sync_orphan` read two ways (the CAS refused for good) | low | **fixed** | `parseOrphanList` reads a non-list value as a list of that one value, like the hook's append, the CAS, the removals and `turnOff`: a bare record is an entry (folded, retired), anything else one damaged entry (removed: nothing in it) | R4R-4; R5-04 |
| R4R-5: a newer build's record (`v: 2`) deleted as damaged | low | **fixed** | `parseOrphanItem` keeps it as a parked entry (`schema`, `newer: true`): never opened, folded, pushed, or removed as "another vault"; kept by every flow, counted by the notice | R4R-5; `m3-rev20` "a newer build's record … in the locked round"; R5-05, R5-06, R5-07 |
| R4R-7: `foldParkedLocally` ran with sync on (a fourth retirement) | low | **fixed** | returns `"sync_on"` and touches nothing | R4R-7; R5-08 |
| R4R-8: "Advanced" bound to a count read outside the lock | low | **fixed** | `EngineStateStore.discardParked`: the count (and the checksums, when given) and the parked marks checked, and the list read again, in the same vault-lock critical section as the write | R4R-8; R5-09, R5-10 |
| R4R-14: two entries whose union passes 50 000 accounts made the fold throw (every keyed round and the turn-off blocked) | low | **fixed** | the fold parks the combination over `LIMITS.parsedEntries` as `too_large` before `applyRemote`, as one entry over the limit | R4R-14; R5-11 |
| R4R-13: R4-14 is not equivalent | — | **agreed** | — | the review's "R4-14 killer" (adopted) kills it (§7) |
| R4-29 (the HLC tie) | — | **closed** | — | the review's "R4-29's tie" test (adopted) pins the per-entry clamp |
| RV4-21: my sync-off fold test's title claimed "a parked one stays" but planted none | — | **fixed** | — | `m3-rev20`'s test gains a case with a still-parked entry and asserts it stays (its first case kept); the review's RV4-21 killer adopted too |
| R4R-6: a fold blocked by the guard cannot be answered while the entry's stamps are over 24 h ahead (the digest is of the clamped entry and moves with the clock) | low | **recorded** | — | probe `it.fails`. A fix (digest the raw combination) changes R4-29's tie: a design decision |
| R4R-9: a parked entry that becomes readable with nothing new in it, while in sync, is folded every round and never retired | low | **recorded** | — | probe `it.fails`. No data at risk; the fix: retire in the "nothing to do" branch under the CAS's checks |
| R4R-10: one fold over the limit parks every later entry tried with it (departure 4) | low | **recorded** | — | probe `it.fails`. The fix: fold the entries not parked for too_large first |
| R4R-11: with a lying pointer write on the fold's commit, the CAS retires what the round's vault does not hold | low | **recorded** | — | probe `it.fails`. Phase 0's store limitation (§3 item 18); the fix: pass `folded` on only when the reloaded vault is the fold's generation |
| R4R-12: parked entries a turn-off kept are removed silently after a join to another vault (spec gap; since revision 5 also unparked ones a turn-off kept, when the join's fold ends `locked` or `vault_lost`; revision 6: `locked` now refuses, §B item 1) | low | **fixed** (SYNC-DESIGN revision 24, in M6) | entries of another vault parked ("vault"), never removed by a round or a join; deleted only by the user (M6-NOTES §12 item 1) | the probe is now an ordinary test of the rule; `m3-orphan`, `m6-other-vault` |
| Info: a parked newer-schema pushable entry pushed at its own (base, head) after a downgrade pauses the older builds (`paused_newer`) until they update (departure 5) | info | **noted** | — | — |
| Info: the "key provably gone" rule also matches a key newer than the chain (only after a PITR past a rotation with a lost identity, pins reset); spec-literal | info | **noted** (for the design owner) | — | — |

---

## 0b. Revision 4: the third review (M3-R3-REVIEW) and design revision 20

The third review's test files are adopted as they came (`test/unit/m3r3-review-probes.test.ts`,
`test/fault/m3r3-review-crash.test.ts`, `test/regression/m3r3-review-phase0.test.ts` with its reference copy of main's
store, `test/helpers/store-main.ts`). Their FINDING tests (R3R-1, -1b, -1d, -2b, -5, -7) ran as `it.fails` until revision
20 arrived and pass now; R3R-3 asserts `vault_lost` and R3R-4 the parked behaviour. The only other change to them: the
records they plant are wrapped in revision 20's list (`{v: 1, items}`), and R3R-5's precondition ("no outbox while
lastSynced is null") now asserts the merge-only outbox that replaces it. New: `test/unit/m3-rev20.test.ts` (14, the §8.2
revision-20 cases the probes do not cover, and the killers of four first-pass mutant survivors), the model's three new tear kinds, and killers for RV-08 and RV-19.

| Finding | Severity | Verdict | Code | Tests |
|---|---|---|---|---|
| R3R-1: the locked push dropped a stale live outbox (409, another device first, a second save during the push); one later tear then lost the save everywhere | high | **fixed as revision 20 says** (demote, never drop) | `engine.ts lockedRound`: the three `dropOutbox` calls are `state.demoteOutbox` (`engine/state.ts`): under the vault lock, if the outbox is still that one, ONE write appends it to the orphan list and clears `sk_sync_outbox` and lastSynced (the recovery hook's own write); always appended, never over an entry, no "orphan there → drop" branch. The two deletions §4.7 allows stay: the unlocked "nothing to send" round and `casLastSynced` | R3R-1, -1b, -1d, -1c; `m3-rev20` (a demotion, then two recoveries: three entries, one round folds and retires them); the model's `elsewhere_then_push` and `save_during_push` kinds; mutants R4-01 to R4-05 |
| R3R-5: a save made while an orphan waited had no second copy; a second tear lost it | medium | **fixed** (option a) | the outbox writer (`local/outbox.ts`): with lastSynced null it writes the MERGE-ONLY outbox `{v: 1, from: null, checksum, envelope}`, the committed generation's own local envelope text (not re-encrypted, not padded), each one over the last; never pushed (`parseOutbox` needs a proof: the push path never sees it); over MAX_ENVELOPE_BYTES nothing is written and the record there stays. The hook appends it like a pushable one. `casLastSynced` removes it in the write that sets lastSynced | R3R-5; `m3-rev20` (overwritten by every save; never pushed; the second tear brings both back); `m3-engine-units` ×2 (the record, the size skip); `m3-faults` (rewritten: merge-only, not pushed, removed by the full round); the model's `second_tear` kind; mutants R4-06 to R4-09 |
| R3R-4: an orphan no round could fold held the device on full rounds and stopped rotation | low | **fixed** (parking) | the fold (`engine/orphans.ts foldOrphans`) parks an entry it cannot open now (a key this keyring does not hold: `reason: "key"` with that key's id; a newer schema; a fold over the entry limit) with a stored mark `parked: {reason, vkId, at}`; `casLastSynced` refuses only for unparked entries it did not fold, keeps parked ones; every keyed round retries them; the mark is cleared when one folds. Removed only when its key is provably gone (the full round confirmed the chain and the id is not in it: one `orphan_unreadable`, now with `n`), or it is damaged or of another vault | R3R-4 (rewritten: lastSynced set, 0.2 pulls per round, the rotation done); `m3-orphan` (the newer-schema test rewritten: parked, sync goes on, the outbox pushable again, a rotation works; RV-08: too_large parks); `m3-rev20` FIXa2 (parked with its key id, folded after the adoption); mutants R4-13 to R4-19 |
| R3R-2: the record-deleting flows deleted an orphan the fold had to keep | low | **fixed** (keep, never refuse) | `SyncLocal.turnOff` (M2, §6) keeps the parked entries: `sk_sync_orphan` survives D11 holding only them, and goes when none is left; the engine flows refuse only for UNPARKED entries they could not fold (`orphanLockedOut`). With sync off: `foldParkedLocally` (`engine/orphans.ts`; no engine, no network) for the settings page's unlock, `readParkedOrphans`/`parkedSummary` for the notice, and `discardParkedOrphans` ("Advanced": only with the count the user confirmed) | R3R-2b, R3R-7; `m3-rev20` ×4 (turn-off keeps the parked one and folds the other; the sync-off fold; the confirmed delete; locked: refused with an unparked entry, not with parked ones); `m2-sync-local` (turnOff); mutants R4-20 to R4-23 |
| R3R-3: a lost or empty vault was reported as `locked` | low | **fixed** | `foldForFlow` returns `{status: "none" | "done" | "locked" | "vault_lost", folded}`; `orphanLockedOut` returns null, "locked" or "vault_lost"; `KeyOpError("vault_lost")`, `EnrollError("vault_lost")` | R3R-3 (rewritten: vault_lost); mutants R4-24, R4-25 |
| R3R-6: the join undos could not pass a guard answer | low | **fixed** | `requireOff(e, answer)`: `joinWithRecoveryCode` passes `i.answer`; `ApprovalJoin.start` and `firstUpload` take an optional `answer` for the same; `round({answer})` answers a blocked fold too (§1.2, §10 item 14) | `m3-rev20` (M3R-9's undo blocked by the guard; the join's own answer lets it and the join through); R3R-6 (the round's answer is bound to the entry's digests); mutants R4-26, R4-27 |
| RV-08 survivor (a too_large fold removed the orphan) | — | **killed** | — | `m3-orphan` "a fold that would pass 50 000 entries" (now: kept and parked `too_large`) |
| RV-19 survivor (the approval join without `refNow`) | — | **killed** | — | `m3-rereview` "a device two days slow turns sync off and joins again by approval" |
| RV-18 survivor (orphan_unreadable without the "listed" check) | — | **not reachable**: no test | a parked "key" entry whose key IS listed needs a previous-key entry that the current key cannot unwrap. No code writes one (`rekey` re-wraps every previous key it can open and drops the rest), so it takes a corrupted keyring entry that the server's bundle carries too (keyStatus must be ok). Mutant R4-19 reports it | — |
| R3-13b (equivalent) | — | **agreed** | `turnSyncOff`'s `context()` refuses a locked vault first | — |

### 0.1 The orphan list as built (SYNC-DESIGN §4.7, revision 20)

- **The record.** `sk_sync_orphan = {v: 1, items: [...]}` (`local/keys.ts`). Each entry is an outbox record as it was
  kept: PUSHABLE `{v, base, head, from, checksum, envelope, proof}` or MERGE-ONLY `{v, from: null, checksum, envelope}`,
  plus the engine's `parked` mark when it is parked. Not vault data (a profile with only sync records opens as empty).
  Not a `VkRecord`. Parsed by `local/outbox.ts parseOrphanList` (an entry that does not parse is damaged; revision 5: a
  stored value that is not a list is read as a list of that one value, everywhere; an entry of a newer format, `v`
  above 1, is parked as `schema` and never opened).
- **Who appends: the recovery hook, the demotion and (revision 6) the turn-off's move of the live outbox, nothing else.** `SyncStateStore.recoveryHook()` (`local/state.ts`,
  the store's `beforeRecoveryWrite`): one `storage.local.set` that clears lastSynced and appends the outbox (pushable or
  merge-only) to the list; `appendOrphan` keeps a stored non-list value as an entry. `EngineStateStore.demoteOutbox()`:
  the same write for a pushable outbox the locked push cannot send. `clearLastSynced()` and every other clear of
  lastSynced (join, cloud restore, key commits, `pins.begin`) never touch the list.
- **The outbox writer** (not wired: M5): lastSynced set → the pushable outbox as before; lastSynced null → the merge-only
  outbox; over MAX_ENVELOPE_BYTES → nothing written, the record there kept (revision 20: an unconfirmed outbox is never
  deleted here; before, the pushable branch dropped it).
- **The store's hook over lost data runs before the caller's function** (`store.ts write`, revision 3, §6).
- **Push** (the locked round and `push()`): a merge-only outbox is never pushed. A pushable live outbox: as before, except
  that 409, write_denied with the key moved, and a server not at its (base, head) DEMOTE it. Without a live pushable
  outbox: the one entry with a proof whose (base, head) is the server's (at most one: the head is a SHA-256 of an envelope
  text) is pushed; 200 retires it; an earlier push whose answer was lost (the server at base + 1 with its own text)
  retires it; anything else keeps it. Entries of another vault (startOver's residue) are removed, never pushed. Parked
  pushable entries are pushed by the same rule.
- **Fold** (`engine/orphans.ts foldOrphans`; the round's `loaded()` at step 0, before the status, so "however the round
  ends"; `foldForFlow` for the flows): only where the key is (never the popup). Each entry: retired at once if its
  checksum is the active generation's (retirement 3); opened with the current VK or the keyring's previous VK of its id,
  the vault id checked; removed if damaged or of another vault; PARKED if under a key this keyring does not hold, of a
  newer schema, or (below) over the limit. Every openable entry is clamped on its own (the stored offset, as applyRemote
  clamps) and the clamped entries are merged into one remote, folded by M2's `applyRemote` in one commit (the guard; HLC
  suffixes make their deletions this device's own: no danger banner). A guard block keeps every entry (MergeBlocked /
  `review_needed`; the answer binds to the digests seen). A fold that would pass the entry limit parks all the entries it
  tried (`too_large`), also when entries that each fit pass it together (revision 5, R4R-14: checked on the combination
  before `applyRemote`, which would otherwise throw a parse error). The parked marks are written by the fold (set, or cleared when an entry folds). Folding never
  retires.
- **Retirement, exactly three ways:** the push's 200; the `casLastSynced` write that sets lastSynced at the end of a full
  round (upload or nothing to upload) retires every entry that round folded (and drops damaged ones), in the same
  `storage.local.set`; the checksum equal to the active generation's.
- **The invariant by mechanism:** `casLastSynced` refuses while an UNPARKED entry the round did not fold remains; parked
  entries stay and do not hold it. So an unparked entry ⇒ lastSynced null ⇒ no pushable outbox (the writer writes the
  merge-only one) ⇒ every save until the next keyed round is in the merge-only outbox, which the next recovery appends.
- **Parked:** shown through `parkedSummary(view().orphans)` (sync on) or `readParkedOrphans(kv, lock)` (sync off): a
  count and the reasons ("schema": update Sixkey; "key": unlock with the newer password / adopt; "too_large": make room).
  "Advanced": `discardParkedOrphans({kv, vaultLock}, {count, checksums?})` deletes them only when they are still the ones
  shown (revision 5, R4R-8: the count, the checksums when given, and the marks checked under the vault lock, in the
  delete's own critical section).
  Removed automatically only when a full round saw the server on the local key with keyStatus `ok` and the entry's key id
  is neither the current nor a listed previous one (one `orphan_unreadable` notice with `n`).
- **Flows.** Those that replace or re-key the vault fold first: the join (both paths, before `prepareJoin`), the
  rotation (its merge-first round), R3 and the cloud restore (just after `commitKeys`, in their own transact, as in
  revision 3: §3 item 26). Those that delete the sync records (`turnSyncOff`, `removeSyncIdentity`, M3R-9's undo, the
  revoked-pending undo, the prelude's unfinished turn-off) go through `orphanLockedOut(answer)`: fold, then refuse only
  for an unparked entry left unfolded (`locked`, or `vault_lost` with no local vault), before anything is revoked or
  deleted; `SyncLocal.turnOff({folded})` keeps every entry the flow did not report folded (revision 5, R4R-1: the first
  upload's undo folds nothing and keeps them all; an entry appended during a turn-off's revoke stays). `foldForFlow`
  loads the vault before it reads the list (revision 5, R4R-2). With sync off, `foldParkedLocally` on every
  settings-page unlock (revision 5: it refuses with sync on, `"sync_on"`). Revision 6: the turn-off also moves the live
  outbox into the list unless the active slot on disk provably holds it (R5R-2); both joins refuse `locked` when a
  locked context leaves an unparked entry unfolded, and the approval join folds again at the prepare (R5R-1).
  R2 and this device's own password and recovery-code publishes leave the list alone.
- **Bounds:** one entry per recovery or demotion, each ≤ MAX_ENVELOPE_BYTES; a keyed round folds every openable one; no
  time ageing.

### 0.2 Departures from revision 20 (each with its reason)

1. **R3 and the cloud restore fold after `commitKeys`, not inside its transact** (as in revision 3, §3 item 26; the third
   review verified it with a crash matrix: `m3r3-review-crash`).
2. **startOver does not delete the list itself**: the next round in any context removes entries of another vault, never
   pushing them (§3 item 27: startOver is VaultService code in the popup's bundle).
3. **The fold merges the clamped entries into one remote and calls applyRemote once** (one guard check, one commit), rather
   than one applyRemote per entry: §4.7's `merge(clamp(本地), clamp(条目₁), …)` as one local commit, which is what it says,
   implemented with M2's one-remote applyRemote.
4. **A fold over the entry limit parks every entry it tried**, not the largest subset that would fit (no partial folds:
   which subset to drop is a choice the user should make, and the entries are all kept).
5. **Parked pushable entries can still be pushed** when the server is exactly at their (base, head) (§4.7 limits the push
   to the matching entry; it does not exclude parked ones; the push is the write that entry was made for).
6. **The over-limit pushable outbox is no longer dropped by the writer** (the record there stays): §4.7 says so for the
   merge-only one; "an unconfirmed outbox may be deleted only in three cases" covers the other.
7. **`firstUpload` and `ApprovalJoin.start` take `answer` too** (R3R-6 names the two join undos; the first upload's undo is
   the same `requireOff`).
8. **The UI state for parked entries is a summary function, not a new SyncStatus** (`parkedSummary`, `readParkedOrphans`):
   a parked entry does not stop sync, so the status stays what the round says; M6 shows the notice beside it.
9. ~~`turnOff` keeps entries by their stored mark~~ **withdrawn in revision 5** (R4R-1: the claim "no other caller" was
   wrong; the first upload's undo is one): `SyncLocal.turnOff({folded})` keeps every entry the calling flow did not
   report folded (§0a above).
10. (revision 4, listed here as the fourth review numbered it) **The outbox writer returns at once with sync off** (no
    `sk_sync_cfg`, read with the state in one get, inside the vault lock): its callers gate on the sync context already;
    the second gate makes "no outbox of any kind while sync is off" hold even for a caller that forgets. The review
    verified it by inspection; `m3-rev20` "no outbox of any kind … while sync is off" and mutant R4-30 test it.
11. (revision 5) **"Advanced" re-reads before it deletes** (a compare-and-set inside the vault lock) besides checking the
    count and the marks there; and `parkedSummary` lists the parked entries' checksums, which `discardParkedOrphans`
    takes to bind the delete to exactly what was shown (R4R-8; required since revision 6, R5R-3).
12. (revision 5) **A record of a newer format (`v` above 1) is parked with reason `schema`** (the way out is the same:
    update Sixkey), never opened, folded, pushed or judged "another vault"; the design text only names a newer schema
    (R4R-5).
13. (revision 6) **The approval join folds a second time, at the prepare** (§3.5 names one fold before the join): the
    page may be unlocked, or an entry added, between the start and the code (R5R-1).
14. (revision 6) **Turning sync off moves the live outbox into the list** unless the active slot provably holds it
    (D11 deletes the outbox; §4.7's "an unconfirmed outbox is deleted only in three cases" is applied to it, R5R-2).

---

## 0c. Revision 3: the re-review's findings and design revision 19 (the orphan rules superseded by revision 20, §0.1)

Every finding was reproduced with the re-review's probe first. The probes and fuzzers are now regression tests:
`test/unit/m3rr-probes.test.ts` (15: RR-A to RR-K, RR-D split in three and adapted to the fix),
`m3rr-fs-probes.test.ts` (8: FS-1 now asserts M4's answer; FS-2 to FS-7 pin the documented differences, §3 item 16),
`m3rr-rotation-fuzz.test.ts` (the re-review's rotation fuzzer, plus a second run with dirty tears) and `m3rr-replay.test.ts`
(the M3RR-13 seed). New in this revision: `m3-orphan.test.ts` (22, revision 19's orphan, one test per case of the design's
list) and `m3-rereview.test.ts` (22, the rest of the findings and a killer per surviving mutant).

| Finding | Severity | Verdict | Code | Tests |
|---|---|---|---|---|
| M3RR-3 / revision 19: D1 deleted the outbox that held the only copy of an acknowledged save | medium | **fixed as revision 19 says** (§4.7) | §0.1 below | `m3-orphan` (22), `m3rr-probes` RR-E, `m3-review` R1b (rewritten: §6), `m2-sync-local`, `m2-store` (2), the model's `tear` family (dirty tears, 7 kinds), the rotation fuzzer with tears |
| M3RR-1: a lost rotate answer, retried, said `not_synced` while the rotation was in effect | medium | **fixed** | `keys.ts commitRotation`: the bundle and verifiers sealed once per handle; the pending record (the new recovery wrap's fingerprint, the new kver) written before the first send; each pass asks the status, and if `vk_id` or `kver` moved since the plan, `GET /v1/keys` and M1's `reconcileKeyOp` decide: in effect → committed here (`recovery_in_effect`), else `changed_elsewhere` (pending cleared). Once a send of the handle had an unknown outcome, every later failure is `unconfirmed` (pending kept), never `not_synced` | RR-A; `m3-rereview` "pending before the first send", "changed elsewhere, the late one refused"; the fuzzer (`retryNotSyncedInEffect` = 0 in every run) |
| M3RR-2: a sustained 503 became a fixed ~10 s retry loop | medium | **fixed** | `engine.ts guarded/failed`: every failure counts, a 503 with Retry-After too (Retry-After is the floor of the exponential backoff); only an explicit round pressed inside a running backoff and answered 429 with Retry-After does not count again | RR-G (10 rounds in an hour); `m3-review` M3R-15 (rewritten: §6) |
| M3RR-4: the rotation's base read could be split by a round in another context | low | **fixed** | every key operation holds `sixkey-sync` like a round: `commitRotation` per pass (the merging round runs between passes, outside it: the lock is not re-entrant), `changePassword`, `commitRecoveryCode`, `repairKeys` and `adoptWithSecret` through `holdingSync` (busy: retried after the conflict delay, 20 times, then `busy`). The worker's transport for a page still never takes it | RR-C; `m3-rereview` M3RR-4 ×2 (a round in another context is `busy` while the PUT /v1/keys or the rotate is in flight) |
| M3RR-5: `commitRecoveryCode` not gated by the kill switch at send | low | **fixed** | `versionGate` before the pending record and the send; `commitRotation` checks the status in every pass | RR-B; `m3-rereview` MY-07 |
| M3RR-6: M3R-7's ten minutes on the local clock, from before the first send | low | **fixed** | `pendingRecoveryWrap.at` is `refNow()` (the corrected clock), refreshed after every send attempt (`touchPending`); `recoveryNotice`/`pendingDue` compare on `refNow()` | RR-F |
| M3RR-7: M3R-9's undo while the old request could still land | low | **fixed** | `enrollSentAt` written before every init and complete attempt; `requireOff` undoes an unknown pending identity only once 2 × SIG_WINDOW_S (corrected clock) has passed since, else `EnrollError("unfinished_wait", msLeft)` | RR-D ×3 (adapted: refused while it can land; it lands and the device is on; after the window the undo goes ahead and the late request is refused) |
| M3RR-8: no way back when the pending identity was revoked | low | **fixed** | `403 device_revoked` for a pending identity: undone at once (it can never be used again), after the orphan fold | RR-I |
| M3RR-9: a stopped round or push reset the stored server offset to 0 | low | **fixed** | the offset is written only when this run saw a server time (`timeSeen`); `push()` seeds it from storage like the round | RR-J; mutants R3-31, R3-32 |
| M3RR-10: a persistent `403 write_denied`: five full PUTs, reported `version_conflict` | low | **fixed** | after a `write_denied`, one more status: restart only if `vk_id` or `kver` moved, else stop with error `write_denied` (counted); locked: the outbox kept unless the key moved | RR-K (1 PUT); `m3-review` "a PUT answered 403 write_denied" (rewritten: a real key move, needs_password) and "a persistent write_denied" |
| M3RR-11: ten surviving mutants | medium (tests) | **fixed** | — | `m3-rereview` "the re-review's surviving mutants" (MY-01, -04, -07, -08a, -10, -11, -17, -18, -19, -23, -25); all 26 of the re-review's mutants re-run (§7) |
| M3RR-12: docs | info | **fixed** | the duplicated M3-01..43 table removed; `not_synced` (§1.2, §3 item 22) and §10 item 14 corrected; the FakeServer's Content-Type comment; `rejectedCheckedAt` is now written only when the server answered (an offline daily retry is not spent) | `m3-rereview` M3RR-12 |
| M3RR-13: a late PUT after an honest PITR, accepted by `if_version` over another head | low (protocol) | **noted only** (revision 19: M8's restore fence, §5.2) | — | `m3rr-replay` pins it: the seed converges; its one problem is that write (§10) |
| FS-1: the FakeServer's Content-Type was looser than M4's | info | **fixed** | `jsonContentType` is M4's `json_content_type` exactly: `application/json`, optionally one `charset=utf-8` parameter (case and the spaces around `;` free); `utf8`, a quoted value, a repeated or other parameter, `charset = utf-8` refused (422) | `m3-fake-server`, `m3rr-fs-probes` FS-1 |
| FS-2 to FS-10 | info | **documented** (§3 item 16) | — | `m3rr-fs-probes` FS-2 to FS-7 |
| Found here (the model's new rejoin kinds): a join merged and clamped on this machine's uncorrected clock | low | **fixed** | a join runs with sync off, so no offset is stored: `prepareJoin`'s clamp (and the added mode's stamps) used the local clock, and a device two days slow moved its own unsent entries' stamps back a day at a rejoin (an LWW order changed, no content lost). `JoinInput.refNow` (M2's SyncFlows, §6): the engine passes the clock its enrolment answers corrected | `m3-rereview` "the join's merge on the server-corrected clock" ×2; mutant R3-37 |
| P-RR-1, P-RR-2 | plausible | covered by M3RR-3 and M3RR-1 | — | — |
| P-RR-3 (MY-02 equivalent) | info | agreed | — | — |

---

## 0d. Revision 2: the review's findings (rows marked "rev. 3" changed since)

Every finding was verified with the review's probe before it was fixed; each probe is now a regression test in
`test/unit/m3-review.test.ts` (39 tests), with real assertions instead of the probes' result files.

| Finding | Severity | Verdict | Code | Tests |
|---|---|---|---|---|
| M3R-1: the round read lastSynced before the vault load that can run the storage recovery, then uploaded the recovered older state over the head | critical | **fixed** (rev. 3: `push()` and `commitRotation` tested with a tear too, MY-01/MY-04) | `engine.ts loaded()`: the vault, then the state, on every attempt; the locked branch loads the generation before its state read too (R1b); `push()` the same | `m3-review` M3R-1 ×3 (three devices: X kept everywhere; the popup-first control; R1b locked: rev. 3, the outbox kept as the orphan and pushed, lastSynced stays null); `m3-crash-round` "a storage recovery inside a worker round's own vault load (no popup first)" at every step; the model's `tear` family |
| M3R-2: the rotation took if_version from a fresh status but uploaded the unmerged local vault | high | **fixed** | `keys.ts commitRotation`: the base is lastSynced (read after the vault), and only while the server still holds exactly that version and head; otherwise, and after a 409, a round that must be "ok" merges first, else `not_synced` (rev. 3: only when no send of the handle had an unknown answer, else `unconfirmed`, M3RR-1) | `m3-review` M3R-2 ×3 (a write between prepare and commit; a 409 whose merging round cannot pull; a rollback reusing lastSynced's version with another head); `watchServer` now checks `POST /v1/keys/rotate` (each head opened with its own key, `settle()` once VK2 is known) |
| M3R-3: `update_required` stopped rounds only | medium | **fixed** (rev. 3: at send for `commitRecoveryCode` and every rotation pass, M3RR-5) | `keys.ts versionGate` in `context()` (password, new code, repair, rename, clear history), `adoptWithSecret`, `prepareRotation`/`commitRotation`; `enroll.ts Approver` (respond, approve). Not gated, the defensive operations: `revokeDevice`, `turnSyncOff`, `rejectAllRequests` and the approver's `reject` (§3.14 "emergency revoke never blocked": a design-owner question, §3 item 21) | `m3-review` M3R-3 (no key write, no approval, no adoption; reject-all and revoke go through) |
| M3R-4: the rejected identity's daily retry never happened | low | **fixed** | `engine.ts statusOf`: `rejectedCheckedAt`, written when the server answered the status for a rejected identity (rev. 3: not before the query, so an offline retry is not spent, M3RR-12) | `m3-review` M3R-4 (two days of 30-minute wakes: asked within a day, comes back) |
| M3R-5: the server offset learned at enrolment and before the first merge was not stored | low | **fixed** | `engine.ts` stores the round's estimate before `applyRemote`; `commitJoin` and `firstUpload` store it at the end | `m3-review` M3R-5 ×2 (±2 days: at most one upload per device; the stored offset after the join) |
| M3R-6: a reveal lost on the way stalled the approval | low | **fixed** | `enroll.ts ApprovalJoin`: the reveal body kept and resent identically while the server says "responded" (A15: 200) | `m3-review` M3R-6 (the SAS unchanged, the approver reaches enter_sas) |
| M3R-7: a new recovery key whose PUT never reached the server was never decided | low | **fixed** (rev. 3: on the corrected clock, from the last send, M3RR-6) | `pendingRecoveryWrap` records the base bundle (kver, MAC); "not in effect" once the server still holds exactly that bundle and `UNDECIDED_MS` (twice the ±300 s signature window) has passed; judged even when the keys did not change (`pendingDue`) | `m3-review` M3R-7 (nothing said after 1 min; decided within 20 min) |
| M3R-8: `turnSyncOff` was not idempotent after a lost revoke answer | low | **fixed** | `keys.ts turnSyncOff`: `device_revoked`/`unknown_device` mean revoked; `preSend` maps every API error to a KeyOpError | `m3-review` M3R-8 |
| M3R-9: "join unfinished" had no way back through the enrolment API | low | **fixed** (rev. 3: not while the old request can land, M3RR-7; a revoked pending identity too, M3RR-8) | `enroll.ts requireOff`: a pending identity whose signed status says `unknown_device` is undone (the vault kept) and the new join goes ahead | `m3-review` M3R-9 (join again after a 410 complete; nothing lost) |
| M3R-10: `pinFirstUpload` wrote the pin field vaultId through `identity.update` | low | **deferred to M2** | the write stays: without it an unpinned first-upload identity has `vaultId: null`, and a later cloud restore (§4.13) would take `expectedVaultId` from the server itself (a check this write keeps); `setPins` needs an adopted record this identity does not have, and the review found no pending copy to order against. M2 should offer a `setReference()` and make `update()` refuse pin fields (§8) | `m3-edges` RR-12 (the unpinned identity keeps its vaultId), mutant N-24 |
| M3R-11: six plausible bugs no test saw | medium | **fixed** | — | `m3-review` M3R-11 (MR-06, F5 end to end, MR-02, MR-04, MR-11, MR-12, MR-14, MR-16, MR-19, MR-20, MR-21, MR-22, MR-28); every one of the review's mutants killed (§7) |
| M3R-12: `pending_enrollments` was dropped | low | **fixed** | `sk_sync_state.pendingEnrollments`, written on change only (locked rounds too); the read budget unchanged | `m3-review` M3R-12 |
| M3R-13: the server's error code stored verbatim; TOTP's correction in an engine module | info | **fixed** (the code: `/^[a-z_]{1,40}$/` else `malformed_response`, in `api.ts`); **deferred** (moving `totpOffset`/`clockNotice` to a popup-eligible module touches the popup module list: M5); displaying `lastErrorCode` as untrusted text is M6 | `m3-review` M3R-13 |
| M3R-14: the unlock's R4 order from the stored status; `write_denied` not "the key moved" | low | **fixed** | `adoptWithSecret` derives needs_password from the bundle it fetched (server key ≠ local, or the pin ahead); a PUT's `403 write_denied` asks the status again (rev. 3, M3RR-10: a round again only if the key or kver moved, else error `write_denied`) | `m3-review` M3R-14 ×2 |
| M3R-15: explicit rounds inside a 429 window pushed the backoff to its cap | low | **fixed** (rev. 3 narrows it, M3RR-2) | Retry-After is the floor; only an explicit round inside a running backoff answered 429 is not counted again (a 503 always counts) | `m3-review` M3R-15 |
| P-1: "stale" after the server accepted | plausible | **fixed** | `commitPublished`: `committed_on_server` (the next round adopts or says needs_new_password) | `m3-review` P-1 |
| P-2: one pruned history version failed the F6a walk | plausible | **fixed** | `remote.ts walkHistory` skips a 404 | `m3-review` P-2 |
| P-3: `firstUpload` undid its local half when the `vault_exists` follow-up failed on the network | plausible | **fixed** | `unconfirmed` then (the round settles it) | `m3-review` P-3 |
| P-4: the recovery join's three tries spend M4's recovery quota | plausible | **declined** (kept): a `fail_before` costs nothing; a lost answer is idempotent on the same device and key, and three tries are what the user would otherwise press; documented for M6 | — |
| §4 D1: min_client_version default | M5 item | **aligned** in the FakeServer (`0.1.0`, M4's default) and the test devices (`0.1.0`); the manifest's `0.0.1` is M5's to bump (a test pins the consequence) | `m3-enroll` d6 ×2 |
| §4 D2: the account session's `sub` | M5 item | **fixed**: `sessionFromToken`/`SyncApi.signIn` read the JWT's `sub`; the FakeServer issues and verifies ES256 JWTs like M4 | `m3-fake-server` "the account token is an ES256 JWT" |
| §4 D3–D6, D8, D10–D19 (rev. 15 A5, A7, A11–A20; rev. 16 json_content_type, `aud`/`role`) | — | **aligned** (§3 item 16) | `m3-fake-server` "revision 15 (§0.0o) and M4's order of the checks" ×8 |
| §4 D7 (rate limits), D9 (retention) | — | **not modelled** in the FakeServer (faults inject 429/503 and 404); the engine's handling is tested through them (M3R-15, P-2) | — |
| server_time 0 from M4's outermost 500 handler | info | **fixed**: a zero `server_time` is no clock (the Date header, or nothing) | `m3-review` "server_time 0" |

Against the real M4 server (a private copy of main's `api/server` with the M4 fix pass, taken 2026-10-17T20:15Z, its
own Postgres cluster on TCP 55493, served on 127.0.0.1:8793, min_client_version 0.1.0; nothing in the main tree
touched), the review's live harness plus three scenarios for this revision: **45 passed, 0 failed** (scenarios a–k; the 12 edge cases on both backends, two of whose
"FakeServer differs" expectations now hold on both: A5's `changed_elsewhere` and A14's reject-all; M3R-1, M3R-2 and A17
on both backends; the manifest-version check). §1.3 has the details.

---

## 1. What exists after M3

### 1.1 Files

| Piece | Where |
|---|---|
| The transport interface (HTTP-shaped; a rejection = "outcome unknown") | `src/core/sync/engine/transport.ts` |
| The API client: the 29 operations, signing (M1 `signRequest`/`signForkRequest`), error mapping, server time, one retry on `401 clock_skew` | `src/core/sync/engine/api.ts` |
| The engine: the round (§4.2), the outbox push (§4.7), the wakes (§4.8) | `src/core/sync/engine/engine.ts`, `deps.ts` |
| The one writer of `sk_sync_state`, `sk_sync_outbox` and `sk_sync_cfg.cursor` (vault lock, CAS); the orphan list's demotion, parked marks and removals (revision 20) | `src/core/sync/engine/state.ts` |
| The orphan list's other writer: the store's recovery hook (append) | `src/core/sync/local/state.ts recoveryHook`/`appendOrphan`, wired in `local/port.ts` |
| The fold of the orphan list (revision 20: parking, the one-commit merge), and the sync-off helpers (the settings page's local fold, the parked notice, "Advanced" delete) | `src/core/sync/engine/orphans.ts` |
| Accepting remote data (§4.3) and the F6a walk | `src/core/sync/engine/remote.ts` |
| Time (§4.14) and scheduling (§4.8) as pure functions | `src/core/sync/engine/clock.ts`, `schedule.ts` |
| Key operations, client halves (§3.6–§3.8, §3.6.0, §3.10, §4.2 repair, §3.9 R2/R3/R4/R6) | `src/core/sync/engine/keys.ts` |
| Enrolment, client halves (§3.1 first upload, §3.3, §3.2 both sides, §3.5) | `src/core/sync/engine/enroll.ts` |
| The outbox writer (afterCommit) and the upload envelope (popup-eligible, **not wired**: §3.3) | `src/core/sync/local/outbox.ts` |
| SyncFlows additions: `current`, `generation`, `vaultStatus`, `unlockedKey`, `cleanupDue`, `truncateForUpload`, `prepareUploadRecovery`/`commitUploadRecovery` | `src/core/service/sync-flows.ts` |
| The FakeServer (in memory, all 29 operations, validated against `api/openapi.yaml`, M4's order of checks and revision 15, ES256 account tokens), transport faults | `test/helpers/fake-server.ts`, `faulty-transport.ts` |
| The review's probes as regression tests (M3R-1 to M3R-15, P-1 to P-3, the surviving mutants' gaps) | `test/unit/m3-review.test.ts` |
| The re-review's probes, FakeServer probes, rotation fuzzer and model replay as regression tests; revision 19's orphan; the rest of the re-review | `test/unit/m3rr-{probes,fs-probes,rotation-fuzz,replay}.test.ts`, `m3-orphan.test.ts`, `m3-rereview.test.ts` |
| The third review's probes, its crash matrix for departure 1 and its Phase 0 comparison (main's store copied as the reference); revision 20's cases | `test/unit/m3r3-review-probes.test.ts`, `test/fault/m3r3-review-crash.test.ts`, `test/regression/m3r3-review-phase0.test.ts`, `test/helpers/store-main.ts`; `test/unit/m3-rev20.test.ts` |
| The fourth review's probes, killers and crash matrix (revision 5) | `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r4-review-killers.test.ts`, `test/fault/m3r4-review-crash.test.ts` |
| The fifth review's probes and killers (revision 6) | `test/unit/m3r5-review-probes.test.ts`, `test/unit/m3r5-review-killers.test.ts` |
| Test worlds (several devices, contexts, restarts), the crash machinery, the checks, the model | `test/helpers/m3-world.ts`, `m3-crash.ts`, `m3-check.ts`, `m3-model.ts` |

Nothing in `src/` outside `core/sync/engine/` imports the engine, and the popup's module graph holds none of it (a test).
No network, no timer, no `chrome.*`, no clock and no logging in the engine (a test); everything is injected (`EngineDeps`).

### 1.2 The engine API for M5 and M6

```ts
new SyncEngine(deps: EngineDeps)   // one per context that syncs (the service worker, the settings page); never the popup
  // deps: { origin, transport, flows: SyncFlows, local: SyncLocal, kv: chrome.storage.local, vaultLock: webLock("sixkey-vault"),
  //         syncLock: webLock("sixkey-sync", { ifAvailable: true }), now, sleep, scheduler?, rng?, random?, clientVersion,
  //         hlcDevice?, diag? }
  round({ answer?, explicit? }): Promise<RoundResult>  // §4.2 (the key in this context) or the locked status + outbox push
  push(): Promise<RoundResult>                         // the outbox (or an orphan entry) push alone (a worker without the key)
  kick({ immediate? }): Promise<void>                  // "sync soon" (§4.8; HOTP: immediate); persisted, then scheduled
  wake(name, { explicit? }): Promise<RoundResult>      // a timer or alarm fired: a round unless a backoff runs
  start(): Promise<void>                               // the worker started: a round if dirty or an outbox or orphan waits
  view(): Promise<StateView>                           // the panel: status, keyStatus, notices, failures, backoff, offset,
                                                       // pendingEnrollments (the badge, M3R-12), orphans (rev. 20: the list;
                                                       // parkedSummary(view.orphans) for the parked notice, §6 O12)
  foldForFlow(answer?): Promise<{ status: "none" | "done" | "locked" | "vault_lost"; folded }>
                                                       // §4.7: the entries into the local vault (the flows call it first);
                                                       // throws MergeBlocked on a guard block; parked entries stay
  orphanLockedOut(answer?): Promise<{ refuse: null | "locked" | "vault_lost"; folded }>  // fold, then why a record-deleting
                                                       // flow must refuse; `folded` goes to flows.turnOffSync({ folded })

  refNow(): number; serverOffset: number; api: SyncApi; state: EngineStateStore; deps: EngineDeps

RoundResult = { status: SyncStatus; keyStatus?; pulled; merged; uploaded; pushedOutbox; blocked?: { report, seen }; error? }
SyncStatus  = off | ok | offline | locked | error | busy | needs_password | review_needed | remote_unreadable | server_older_key
            | update_required | too_large | paused_newer | different_vault | rejected_by_server | join_unfinished
            | identity_missing | cloud_restore | damaged | wrong_origin
KeyStatus   = ok | needs_new_password | keys_behind | rejected | update_required
Notices     = rollback | keys_adopted | keys_changed | forked | device_joined | device_revoked | auth_failures | deleted_remotely
            (danger per D6) | recovery_in_effect | recovery_not_in_effect | rev_mismatch | clock_skew | orphan_unreadable (rev. 19)

// keys.ts (each settles the pins first, runs the pre-send check in this context, server first, then commitKeys; the
// writes hold sixkey-sync like a round, M3RR-4)
changePassword(e, old, new); prepareRecoveryCode(e, pw) → { recoveryCode } → commitRecoveryCode(e, handle);
prepareRotation(e, pw) → { recoveryCode } → commitRotation(e, handle) (retry with the same handle after unconfirmed);
repairKeys(e, { oldPassword, password, recoveryCode });
revokeDevice / renameDevice / rejectAllRequests / clearServerHistory(e, …, password);
turnSyncOff(e, pw, { answer? })     // folds the orphan entries first: may throw MergeBlocked { report, seen } (nothing
                                    // revoked yet); KeyOpError("locked") while locked with an unparked one, "vault_lost"
                                    // with no local vault; every entry it did not fold is kept (sk_sync_orphan
                                    // survives: R3R-2, revision 5's R4R-1), and the live outbox is moved into the
                                    // list unless the active slot holds it (revision 6)
removeSyncIdentity(e, { answer? })  // the same
adoptWithSecret(e, { password } | { recoveryCode }, { confirmOlder?, answer? })
  → adopted | local (+ note) | confirm_older | review_needed { report, seen } (call again with answer) | rejected
// errors: KeyOpError(code): M1's refusal reasons, the contract's codes, and
//   unconfirmed        sent at least once with an unknown outcome; the server may hold it (the pending record says
//                      which, the next round settles it); for a rotation: retry with the same handle
//   offline            nothing was sent
//   not_synced         the rotation's merge-first round did not come back "ok" and no rotate of this handle has an
//                      unknown outcome (a later retry with the same handle sends the same VK2 and code)
//   changed_elsewhere  another key change won; this one is not in effect (its code is void)
//   busy               sixkey-sync stayed taken (another context's round) for 20 tries
//   update_required    (M3R-3, at send: M3RR-5); committed_on_server (P-1: in effect on the server, this device catches
//                      up on its next round); stale; locked; …
versionGate(e, signer)  // M3R-3: one status query; throws update_required below min_client_version
// KeyOpError("vault_lost") / EnrollError("vault_lost") (rev. 20, R3R-3): the local vault is lost or empty and an unparked
// orphan entry waits: the cloud restore (§4.13) or a backup first; KeyOpError("locked"): unlock first
// a guard block on any fold can also be answered by round({ answer }): its step 0 folds first (R3R-6)

// orphans.ts (revision 20; no engine needed, for the settings page with sync on or off)
parkedSummary(view.orphans) → { count, reasons: ("key" | "schema" | "too_large")[], checksums } | null
readParkedOrphans(kv, vaultLock)                      // the same from storage (sync off: the security page's notice)
foldParkedLocally({ flows, kv, vaultLock, now }, answer?) → { folded, parked } | "locked" | "vault_lost" | "sync_on"
                                                      // with sync off, on every settings-page unlock; MergeBlocked likewise
discardParkedOrphans({ kv, vaultLock }, { count, checksums })  // "Advanced": both from the parkedSummary the user confirmed
                                                      // (required, revision 6); deletes the parked entries only when they
                                                      // are still exactly those shown (checked under the vault lock);
                                                      // otherwise ServiceError("bad_state"): show the notice again

// enroll.ts
// AccountSession: sessionFromToken(verify's account_token) or api.signIn(email, code): { token, sub } (the JWT's sub)
firstUpload(e, { session, password, recoveryCode, deviceName, email, answer? }) → done | unconfirmed | vault_exists | keyring_changed
resumeFirstUpload(e) → created | not_created | unknown
joinWithRecoveryCode(e, { session, recoveryCode, deviceName, email, confirmLost?, answer? }) → plan; joinSummary(plan); commitJoin(plan)
  // the orphan entries are folded first (revision 6): EnrollError("locked") when an unparked entry is left unfolded
  // because this context is locked (unlock first; nothing replaced); with the local vault lost the join goes on
  // a rejoin into the same vault whose cloud would erase or change accounts here throws M2's MergeBlocked { report, seen }:
  // nothing written to the vault; call again with answer (a new recovery enrolment; the first request expires unused)
  // from "join unfinished": the signed status decides (M3R-9, M3RR-7/8): unknown_device and the old init/complete sent
  // over 10 minutes ago, or device_revoked → the old local half is undone (after the orphan fold) and the join goes on;
  // unknown_device sooner → EnrollError("unfinished_wait", msLeft); known (200) → already_on; offline → offline;
  // any other answer (a 5xx) → status_failed (nothing undone); locked with an unparked orphan entry → locked, the local
  // vault lost with one → vault_lost (nothing undone; parked entries never refuse it: turnOff keeps every entry the
  // undo did not fold, revision 5)
ApprovalJoin.start(e, { session, deviceName, email, answer? }) → poll() / submitConfirmationCode(cc) → plan / cancel()
  // `answer` on all three (R3R-6): it also answers a guard block on the undo's fold (M3R-9, the revoked pending identity)
  // the orphan entries are folded at start() AND again in submitConfirmationCode's prepare, before prepareJoin (revision
  // 6): either refuses with EnrollError("locked") when an unparked entry is left unfolded because this context is locked,
  // and a guard block throws MergeBlocked; after a refusal at the code nothing was prepared or written: cancel() and
  // start again (requireOff replaces the unpinned pending identity at once; the new start folds or refuses the same way)
Approver.list(e); Approver.start(e, rid, password) → poll() / submitSas(sas, password) → { cc } / reject(password)
```

The UI (M6) shows `view()`; the worker (M5) maps a `Wake` to `setTimeout` (under 30 s) or `chrome.alarms` (from 30 s),
calls `wake` when it fires and `start` at every worker start, creates the 30-minute periodic alarm with
`periodicPhaseMinutes(random)`, and builds one engine per context. A round's review answer (`blocked.seen`) is kept in
the page's memory only.

### 1.3 How the same tests can run against the real server (M5/M6)

The engine sees only `Transport`. The FakeServer is a `Transport` plus an admin interface the tests use for faults,
rollbacks and inspection. Tests that need only `transport()` and `session(email)` (the round, the key operations, the
enrolments, the source of `test/unit/m3-engine-round.test.ts`, `m3-keys.test.ts`, `m3-enroll.test.ts`) can run against M4
by giving `World` a backend whose `transport()` sends real requests (M5's fetch transport in Node) and whose
`session(email)` reads M4's FakeAuthProvider inbox. The admin-dependent tests (rollbacks, faults injected at the server,
`state()`) stay FakeServer-only; the transport-level faults (`FaultyTransport`) wrap either backend. M3 does not add that
backend to the patch (no network in M3); `World` takes the server as a constructor option so the seam is there.

Run for this revision, outside the patch: the review's live harness (`scratchpad/m3-m4live/extension/test/live/`, a
Node `fetch` transport, the JWT's `sub`, the FakeAuthProvider inbox) copied over this tree, against a private copy of
main's `api/server` (twice: before and after the M4 fix pass landed; the second copy taken 2026-10-17T20:15Z) on its
own Postgres cluster: scenarios a–k (12), the edge
cases E1–E12 on both backends (25), M3R-1/M3R-2/A17 on both backends (6), and the manifest-version check (1): 45 passed
(logs: `scratchpad/m3/live/live-run.log`, `live-run2.log`). Two expectations of the harness asserted the FakeServer's old answers (E3 the
pre-A5 `password_mismatch`, E11 the pre-A14 reject-all scope); both backends now give the same answer, and the harness
was changed to expect it on both. **Revision 3:** the same harness over the final revision-3 tree (the `src/` of this
patch, synced into the harness copy just before the run), against a fresh copy of main's `api/server` (2026-10-18, its
revision-18 state with the A21 ceiling change) on the same private cluster: 44 passed with client version 0.1.0, and
the manifest-version check (client 0.0.1 against M4's default minimum 0.1.0) 1 passed: **45 passed, 0 failed**
(`scratchpad/m3/live/live-run4.log`, `live-run4-mincv.log`; an earlier run on a mid-revision tree, `live-run3*.log`, also
45/45).

---

## 2. Requirement map

### 2.1 SYNC-DESIGN §9, the M3 row

| Requirement | Code | Tests |
|---|---|---|
| `lastSynced = {version, head, checksum}`, the clear mechanism (D1) | `engine.ts attempt`, `state.ts casLastSynced` | `m3-engine-units` (CAS, D1), `m3-scenarios` F3/D1, `m3-check` lastSynced invariant in every fault test |
| `needPull` by (version, head) (F4, D5) | `engine.ts attempt` | `m3-scenarios` F4/D5, `m3-faults` D5 outbox |
| Clamp and "compared with the raw remote" (F5) | `engine.ts attempt` (needUpload), M2's applyRemote | `m3-scenarios` F5 (±2 days, each uploads at most once), `m3-edges` F5 clamp |
| The F6a walk; R6 stop at a newer schema | `remote.ts walkHistory`, `engine.ts` | `m3-scenarios` F6a/R6 (head, during the walk, nothing opens) |
| Outbox written at the commit; push with the local CAS (D2) | `local/outbox.ts`, `engine.ts lockedRound`, `state.ts pushed` | `m3-engine-units`, `m3-engine-round`, `m3-scenarios` D2, `m3-faults` exactly once, D5, `m3-edges` failed push |
| The orphaned outbox (revision 19: D1 keeps it; push, fold, three retirements, unopenable, the flows fold first) | §0.1 | `m3-orphan`, `m3rr-probes` RR-E, the model's dirty tears, the rotation fuzzer with tears |
| Adoption R1–R6 through M1 and commitKeys | `engine.ts syncKeys`, `keys.ts adoptWithSecret` | `m3-keys` (R2, R3/R4, R6, GM2-5, N27 ①③④⑤⑥) |
| The guard; nothing of the remote kept; the danger rule (D6) | `engine.ts` (pre-check, MergeBlocked), `mergeNotices`, `keys.ts adoptWithSecret` (review_needed), `enroll.ts` (MergeBlocked) | `m3-scenarios` §4.4 (block, Apply, Keep mine, notice, D6 danger, no write of the digest at any point), `m3-edges` §4.4 (the adoption of a new key, the rejoin) |
| Backoff | `schedule.ts`, `engine.ts guarded/failed` | `m3-engine-units`, `m3-faults` (500, 429/503 Retry-After, bounded) |
| TOTP on the local clock, the optional correction (S3) | `clock.ts totpOffset/clockNotice` | `m3-engine-units`, `m3-scenarios` S3 |
| `keys_behind`; `maxSeenKver = 0` after an identity restore | M1; `engine.ts`, `keys.ts repairKeys` | `m3-keys` N27, `m3-repair` (across a password change, across a recovery-code change, refusals before sending, M2R-2 revoke) |
| Pre-send check and builders in one context (M1-19) | `keys.ts`, `enroll.ts Approver` | every key-op test runs them in one context |
| GM2-5 end to end (R4 order, adopt back) | `engine.ts` D8, `lockedRound`, `keys.ts adoptWithSecret` | `m3-keys` GM2-5 (another VK, the same VK, the double fault) |
| `settlePins()` before every decision; only M1 capabilities to commitKeys | `engine.ts prelude/syncKeys`, `keys.ts context/commitPublished` | `m3-edges` PROBE-2 through the engine, RR-1 (the same adoption raced: a retry; a newer one raced: stale, evaluated again, never committed again) |
| §3.1's local half (truncation before init, pins "in sync", RR-12) | `enroll.ts firstUpload/resumeFirstUpload`, `sync-flows.ts truncateForUpload`, `engine.ts pinFirstUpload` | `m3-enroll` (RR-12 before init, D4 ×2, 409), `m3-edges` (RR-12 after 201 and on resume) |
| The `sk_sync_state` writing rule | `state.ts` (one helper) | `m3-source-rules` (only the writers name the keys), `m3-engine-units` (keeps unknown members) |

### 2.2 The brief's list

| Item | Where | Tests |
|---|---|---|
| status poll, pull, merge via applyRemote with the guard and answers | `engine.ts attempt` | `m3-engine-round`, `m3-scenarios` |
| push with the write proof and the outbox | `engine.ts attempt/putVault/lockedRound` | `m3-engine-round`, `m3-faults` |
| 409: re-pull, at most 5, 200–1000 ms apart | `engine.ts roundInner` | `m3-engine-round` (a real 409), `m3-crash-round` 409 scenario |
| rollback detection incl. the head hash | `engine.ts` | `m3-scenarios` F4/D5 |
| paused_newer (never skipped to an older v1 version) | `engine.ts`, `remote.ts` | `m3-scenarios` R6 ×2 |
| server-corrected time, the HLC clamp | `clock.ts`, M2's mutate/applyRemote | `m3-scenarios` F5, `m3-edges` clamp |
| dirty by envelope checksum | `engine.ts` | `m3-engine-round`, crash and model tests |
| outbox with retries and backoff (`<30 s` setTimeout, `≥30 s` alarms; pure) | `schedule.ts`, `engine.ts kick/wake/start` | `m3-engine-units`, `m3-faults` §4.8 |
| debounce 3 s, persisted (`kickAt`, `dirtySince`) | `engine.ts kick`, `schedule.ts kickWakes` | `m3-faults` §4.8 |
| idempotent merges | M2's applyRemote; `engine.ts` (no change → no commit, no PUT) | `m3-model` ("one more round sends and commits nothing") |
| per-device failure counters as state, not lockouts | `engine.ts refreshDevices` (notices), `failed` (a number) | `m3-faults` S2, bounded backoff |
| keys flows (§3.6–§3.8) with commitKeys and M1 capabilities | `keys.ts` | `m3-keys`, `m3-crash-keys`, `m3-edges` |
| §3.1's first upload as revisions 13/14 say | `enroll.ts`, `sync-flows.ts` | `m3-enroll`, `m3-edges` |
| join/enrol client halves | `enroll.ts` | `m3-enroll` (approval with SAS/CC, wrong CC ×3, wrong SAS ×3, recovery, rejoin) |
| sync_on interplay | M2's `noSync`; `sync-flows.ts truncateForUpload` | `m3-keys` §0.0i item 18 |
| cfg_missing: finish the turn-off, never a round | `engine.ts prelude` | `m3-enroll` §2.5 |
| clone cursor with vault writes only | `state.ts cursorForPut/cursorAccepted`, `engine.ts putVault` | `m3-enroll` §4.10 ×3, `m3-source-rules` T2 |
| min_client_version | `engine.ts statusOf`, `versionBelow` | `m3-engine-units`, `m3-enroll` d6 |
| `keys_adopted` recorded for M5/M6 | `engine.ts syncKeys`, `keys.ts adoptWithSecret` (security record + notice) | `m3-keys` GM2-5 same VK |
| the request signer behind an injected transport | `api.ts` | everything (the FakeServer verifies every signature) |

### 2.3 M2-NOTES §7, the hand-off checklist (with the re-review's corrections)

| # | Item | Done in | Tests |
|---|---|---|---|
| 1 | settle before every decision, never in the popup, never under the vault lock | `engine.ts prelude` (status()), `syncKeys`, `keys.ts context`, `commitPublished`, `enroll.ts commitJoin` | `m3-edges` PROBE-2; `m3-source-rules` (no engine in the popup) |
| 2 | commit only M1 capabilities; drop a stale one and evaluate again; never mutate what M1 got; one context | `engine.ts syncKeys` ("stale" → restart), `keys.ts` | `m3-edges` RR-1 ×2 (retry; stale); key-op tests |
| 3 | decrypt remote vaults with the current VK only; check vkId and vault id first | `remote.ts openRemote` (other_key, wrong_vault), `walkHistory` (other keys passed over) | `m3-engine-units` remote; `m3-scenarios` F6a |
| 4 | the guard first; keep nothing on MergeBlocked; [Apply] re-pulls with `{seen, accept}`; the answer in memory only; D6 | `engine.ts`, `keys.ts adoptWithSecret`, `enroll.ts joinWithRecoveryCode` | `m3-scenarios` §4.4 (incl. "the digest is never written"), D6; `m3-edges` §4.4 (adoption, rejoin) |
| 5 | the outbox in afterCommit (no network, no cleanup); the CAS on push | `local/outbox.ts`, `state.ts pushed` | `m3-engine-units`, `m3-scenarios` D2; **wiring is M5** (§3.3) |
| 6 | one helper for `sk_sync_state`, a source rule | `state.ts` | `m3-source-rules`, `m3-engine-units` |
| 7 | D8 forward after a settle; `pin_ahead` → needs_password; + discontinuous → rejoin (M6) | `engine.ts attempt` (forward / needs_password), `lockedRound`, `keys.ts adoptWithSecret` | `m3-keys` GM2-5 |
| 8 | identity_missing: restore once unlocked; mirror the state with `cfg.setState`; confirm every restored state with the signed status | `engine.ts prelude` (restore), `markEnrolled/markRejected` (identity then copy) | `m3-enroll` §2.5, P5, `m3-keys` ⑥ |
| 9 | the first upload (noSync truncation, init from the keyring after step 5, the check before "in sync" pins) | `sync-flows.ts truncateForUpload`, `enroll.ts firstUpload`, `engine.ts pinFirstUpload` | `m3-enroll`, `m3-edges` RR-12 |
| 10 | the rotation: no capPrevious while a cleanup is due | `keys.ts prepareRotation` (refused only when the list is full, as `service.capped`) | `m3-keys` rotate (a cleanup due and fewer than 64 previous: not refused) |
| 11 | cfg_missing with a readable vault: never a round or a signature | `engine.ts prelude`, `keys.ts adoptWithSecret` | `m3-enroll` §2.5 |
| 12 | pre-send in one context; revoke never blocked; the old password in the GM2-5 state | `keys.ts` | `m3-keys` ④ |
| 13 | R6: paused_newer on a v2 remote, the F6a walk | `engine.ts`, `remote.ts` | `m3-scenarios` R6 ×2 |
| 14 | D7: too_large past 50 000, not retried every round | `engine.ts` (the `stuck` memo) | `m3-scenarios` D7, "not pulled again" |
| 15 | the Phase 0 key operations refused with sync on | M2 | `m3-keys` item 18 |
| 16 | the join: settle first; the joining identity; answer; prejoin_exists; complete then enrolled | `enroll.ts` | `m3-enroll`, `m3-scenarios` §3.5 |
| 17 | the marker | M2 (none from applyRemote) | — |
| 18 | the popup's module graph | — | `m3-source-rules` |

---

## 3. Decisions and doc ambiguities (for the design owner)

1. **The outbox writer is built, not wired.** §4.7, P10 and §3.11 want every commit (the popup's in "lock every time"
   mode too) to write the outbox in afterCommit; the brief keeps the popup byte-for-byte unchanged and the engine out of
   it. So `local/outbox.ts` imports only what the popup already loads, the tests wire it into their port, and M5 wires it
   into `platform/runtime.ts` (`createSyncPort`'s port gets `afterCommit: createOutboxWriter(local)`). Measured cost of
   that wiring: see §5.1. M2's exact module list in `m2-source-rules` must then gain `src/core/sync/local/outbox.ts`
   deliberately.
2. **The outbox push checks the head too** (§4.7 says "server version == outbox.base"): a version reused after a rollback
   (D5) would otherwise take a push built on another head. The outbox stores `head` and `from` (lastSynced as it was).
   And a push whose answer was lost is recognised: the status shows `outbox.base + 1` with the head of the outbox's own
   text, so lastSynced moves on without a second PUT.
3. **The full round's lastSynced is a CAS too**: written only if the active generation's checksum is still the one
   uploaded (or found in sync) and lastSynced is still what the round read. A CAS on lastSynced alone would pass after a
   recovery that nulled it again when the round began from null (D1).
4. **The §3.1 truncation and 4(b)'s show-before-commit recovery key are SyncFlows methods** (`truncateForUpload`,
   `prepareUploadRecovery`/`commitUploadRecovery`), each with the `sync_on` check inside its transact, not VaultService
   methods: service.ts is in the popup's bundle.
5. **RR-12 at step 6, no dead end**: if the keyring read after step 5 is not the truncated one (a Phase 0 key operation
   in another tab between the truncation and step 5), `firstUpload` sends nothing, undoes step 5 (`turnOffSync`) and
   returns `keyring_changed`; the user starts again (the truncation runs again).
6. **The approval path has no vault before `complete`** (§3.2's payload carries the bundle, not the envelope, and GET
   /v1/vault needs a device signature). The join is prepared against an empty cloud vault of that id; the first round
   pulls and merges the real one (M8). A profile that already has accounts therefore joins in the added mode without the
   dedupe against the cloud's accounts: an account on both sides appears twice (different ids). Nothing is lost. Options:
   the payload carries the head envelope (a contract change), GET /v1/vault accepts `Sixkey-Enroll` once approved, or a
   dedupe pass after the first round. The recovery-code path (§3.3) returns the envelope and dedupes.
7. **"In sync" with a higher kver writes no pins** (§2.5 "确认已同步时不写"), so `maxSeenKver` does not rise then (M1's
   `in_sync` carries the higher value). Harmless; noted because M1's comment says "store maxSeenAfter".
8. **An identity restored from its copy gets `maxSeenVersion = lastSynced.version`** (a lower bound), not the server's
   version: the server cannot be asked before the identity exists. One rollback warning less at most.
9. **cfg_missing with a never-pinned pending identity is an enrolment in progress** (§3.1 step 5, §3.2 N1: the identity is
   made before `sk_sync_cfg`); the engine leaves it alone. Only an identity that was enrolled (or pinned) finishes the
   turn-off (RR-10).
10. **D7, "not retried every round"**: a head that cannot be taken in (too_large, paused_newer, remote_unreadable,
    different_vault) is remembered with the local checksum and the client version (`stuck`); it is pulled again only when
    one of them changes.
11. **A Phase 0 wrinkle**: `purgeEntry` drops an erased HOTP entry's counter while `mergeEntry` keeps the highest counter
    (for associativity), so the counter of an erased entry can come back after a merge. No data (the secret is gone); the
    model and crash tests compare vaults with erased entries' counters set aside, and flag every other difference.
12. **The engine's key operations hold `sixkey-sync`** (revision 3, M3RR-4; SYNC-DESIGN §4.9 as revision 19 has it): a
    round in another context between the rotation's vault load and its state read could otherwise move lastSynced under
    it. `commitRotation` holds it per pass (load, state, status, send) and runs its merge-first round between passes
    (the lock is not re-entrant); the other writes hold it for the whole operation (`holdingSync`). Taken: retried after
    the conflict delay, 20 times, then `busy`. The worker's transport serving a page still never takes it.
13. **The rotation's version_conflict** reruns a round (the merge) and sends the same VK2, keyring2 and code2 again with
    a new envelope (§3.8 P3); the device names are re-encrypted each time.
14. **The HOTP pull before a code (§4.12, 2 s)** is the UI's: `Promise.race(engine.round(), 2 s)` in M5/M6. The engine's
    part is `kick({ immediate: true })` and the counter's max through the merge (tested).
15. **`rejected_by_server` retries once a day** by `rejectedCheckedAt` (when the status was last asked for it, M3R-4);
    an explicit "retry" runs at once.
16. **The FakeServer follows revision 15 and M4's order** (`api/server/sixkey_server`, read for each point): the account
    token is an ES256 JWT (kid, alg, aud, role, iss, exp, iat, a UUID `sub` and `session_id`), verified on every use; the
    signer is authenticated before the body is read (the headers' shape, the row: `unknown_device` or 410, the signature,
    revoked, the window), then strict JSON (A18: duplicate keys, NUL, lone surrogates; integer tokens; an empty body) and
    the schema, 422; PUT /v1/keys: shape and kver range, the idempotent 200, `keys_conflict`, the proof, then vaultId, vkId,
    `by` and P4 (A5); rotate: shape, the idempotent 200, `keys_conflict` first when both are stale, `version_conflict`,
    `write_denied`, pw_auth, then P4 and the names (A6, A7: no duplicate id, under the new VK); PUT /v1/vault: the CAS
    (`version_conflict`, `vk_mismatch`) before `write_denied`; `complete` deletes the request (a retry is 410, A17), a
    taken device id is 409 `enroll_state` with the request kept (A16), `name_ct` is 422 on the approval path and under the
    current VK on the recovery path (A19); identical `respond`/`reveal` retries are 200, other values and a repeated
    `approve` 409 (A15); `reject-all` covers approval and recovery requests created up to the signed minute (A14, A2);
    `expires_at` is rounded up to the minute (A13); an enrolled device's `reject` without pw_auth is 403, not counted
    (A11); a valid proof that clears the failures moves `devices_rev` (A12); `name_ct.vkId` is the current VK in init,
    approve, complete, rename and fork (A19); exactly one signer header where either may sign, and `Sixkey-Enroll` = the
    path's rid (A20); init's idempotency compares the stored bundle and the device row (M4's D4); a JSON body needs
    Content-Type `application/json` (only `charset=utf-8`), checked before anything else (revision 16's
    `json_content_type`); `aud` and `role` are exactly `authenticated` (revision 16); min_client_version defaults to
    `0.1.0`. Still not modelled: rate limits (faults inject 429/503) and retention (history is kept whole;
    a fault injects the 404 of a version pruned mid-walk). Revision 3: Content-Type is exactly M4's
    `json_content_type` (FS-1). The differences that remain (the re-review's FS-2 to FS-10, pinned by
    `m3rr-fs-probes` where a probe exists; the client depends on none of them): FS-2 `last_seen_at` written by every
    device-signed request (M4: the status query only); FS-3 respond/approve with a wrong pw_auth on a gone request: 410,
    not counted (M4: 403 `password_mismatch`, counted); FS-4 a registration key off the curve: 401 `bad_signature` (M4:
    422); FS-5 `|` in the target: 422 before authentication (M4: 401 after the body); FS-6 an expired request with a bad
    signature: 410 first (M4: 401); FS-7 the token of a deleted account: `session_invalid` (M4: the JWT only); FS-8 list
    order: insertion (M4: `created_at, id`); FS-9 revocation re-checked inside PUT /v1/vault and rotate only (M4: every
    write transaction); FS-10 an auth salt equal to the wrap salt: 422 (M4: not checked).
17. **The same-VK repair's verifiers follow P4.** The openapi's note on `PUT /v1/keys` says the repair carries
    "recovery_verifier from a typed recovery code" (earlier name), while P4 (the same description, and the server) requires
    `recovery_verifier` exactly when the recovery wrap changed. A rollback across a password change only leaves the
    recovery wrap as the server has it, so P4 forbids the field (422). `repairKeys` checks the typed code locally (N24, I9)
    and sends `recovery_verifier` only when P4 asks for it (`m3-repair` covers both cases). The contract's own example
    (`contract/vectors/sync-v1.json`, `keys_repair`) has both wraps changed, so it agrees with P4 and with the
    FakeServer; only the openapi prose is unconditional. It should read "when the recovery wrap changes", like the
    password one.
18. **A lying disk on the commit pointer (Phase 0's store, not M3).** The crash matrix's "lie" mode (a write acknowledged
    and dropped) applied to `sk_active` during a save loses that save although `mutate` returned: the pointer is the
    commit point and is not read back (the slot is). The storage-recovery scenario of `m3-crash-round` excludes exactly
    that step from its "the save is kept" check and counts every other lie (M3's and M2's sync writes included). If the
    lying-disk model is meant to cover the store, `VaultStore.write` would need to read the pointer back.
19. **D1 and the outbox after a recovery: the orphan list** (revisions 19 and 20; superseding revision 2's note that D1
    drops the outbox). §0.1 has exactly what the code does, §0.2 where it is not word for word revision 20.
20. **The kill switch cannot stop a registration** (M3R-3): before init, a recovery join or an enrolment request there is
    no device to sign a status query, and no unauthenticated endpoint carries `min_client_version`. An old client can
    therefore create a vault or join and is stopped at its first round (the live check shows exactly that). If that
    matters, `GET /healthz` or `GET /v1/account` could carry the minimum (a contract change).
21. **The defensive operations are exempt from the kill switch** (`revokeDevice`, `turnSyncOff`, `rejectAllRequests`, the
    approver's `reject`): an old build can still throw out a device or a rogue enrolment. §3.14's
    "emergency revoke is never blocked" against §4.2 step 1's "停止". The spec does not carve revoke out of
    update_required; the design owner should say which wins.
22. **The rotation needs a merged base** (M3R-2), and a lost answer is reconciled before anything else (M3RR-1):
    `commitRotation` first asks the status; keys moved since the plan → `GET /v1/keys` decides (in effect: committed
    here; else `changed_elsewhere`). Otherwise it merges first when the head is not lastSynced's, and `not_synced` means
    "the merge-first round did not come back ok, and no rotate of this handle had an unknown outcome": after any unknown
    send the answer is `unconfirmed` and the pending record stays. The prepared rotation stays usable either way: a
    retry with the same handle sends the same VK2, keyring and code (sealed once).
23. **"Not in effect" for a code whose request never landed** (M3R-7) waits `UNDECIDED_MS` = 2 × SIG_WINDOW_S (10
    minutes) on the corrected clock from the last send attempt (M3RR-6): after that no signature made when the code was
    sent can be accepted, so the server's unchanged bundle (the same kver and MAC as the code's base) means it will
    never be in effect. That holds only if no request outlives its signature: M5's fetch timeout must be at most 60 s
    and the transport must not retry by itself (§10).
24. **Retry-After is the floor of the backoff, not a pardon** (revision 3, M3RR-2, revision 19's §4.8): every failure
    counts, a 503 with Retry-After too; the next try is the later of Retry-After (capped at 24 h) and the exponential
    backoff. Only an explicit round pressed while a backoff runs and answered 429 with Retry-After does not count again
    (M3R-15's case: the press is the user's, the schedule the server's).

25. **The store's hook runs before the caller's function over lost data** (revision 3; an M2 placement in M1's
    `store.ts write`, §6): over lost data the flow writing the new state (the cloud restore's `commitKeys`) clears its
    own sync state inside that function (`pins.begin`), and revision 19 needs the hook to find the lost generation's
    outbox first. Running it earlier is still "before the write"; a function that then throws leaves lastSynced null and
    the outbox appended to the list (a full pull next time, nothing lost). The other recovery writes are unchanged.
26. **R3 and the cloud restore fold the orphan entries right after `commitKeys`**, not inside its transact as §4.7 says
    ("并入它的合并 transact"): that transact is M2's flow, and its guard answer (`seen`) binds to the adoption's own merge,
    so a second merge in it would need a second answer. Safety: `pins.begin` never touches the orphan, the fold is the
    same `applyRemote` with the same guard, and a crash between the two leaves the orphan for the next round's fold
    (retired only when that round sets lastSynced). A guard block on this fold is left to the round to show.
27. **Orphan entries of another vault are removed, never pushed** (startOver's residue, after the user confirmed): §4.7 says
    startOver deletes it with the residue; startOver is VaultService code (the popup's bundle), so the engine removes it
    instead at the next round in any context (the fold's `wrong_vault`; locked, by the envelope's vault id against the
    generation's). Until then it is ciphertext under a key this profile no longer has.
28. **M3R-9's undo waits while the old request can land** (M3RR-7): `enrollSentAt` (the corrected clock) before every
    init and complete attempt; `unknown_device` within 2 × SIG_WINDOW_S of it → `unfinished_wait` with the time left (the
    page says "try again in N minutes"). After the window the old recovery request has expired too, so M4's
    `one_per_session` 409 cannot meet the new join in the same account session; M6 should still use a fresh session for
    a retry. A revoked pending identity is undone at once (M3RR-8). A 5xx is `status_failed` (nothing undone).

---

## 4. For the design owner (SYNC-DESIGN text)

- **First (revision 4):** §4.7 as built for revision 20 (§0.1) and its departures (§0.2): the one-commit fold of the
  clamped entries, too_large parking all tried entries, parked pushable entries still pushed at their own (base, head),
  the writer never dropping an over-limit pushable outbox, `answer` on the first upload too, the parked notice as a
  summary rather than a status, turnOff keeping entries by their stored mark. And from revision 3: the hook's placement
  over lost data (item 25), the R3 and cloud-restore fold after `commitKeys` (item 26), startOver's entries removed by
  the next round (item 27).
- §3.5 / §2.5: M3R-9's undo with `unfinished_wait`, `status_failed` and the revoked pending identity (item 28).
- §3.5 / §4.14: a join's merge (and the added mode's new stamps) runs on the clock the enrolment's own answers corrected:
  with sync off no offset is stored, and the local clock would clamp the cloud's (and this device's) stamps (§0c).
- §4.7: the push condition is (version, head) = (outbox.base, outbox.head) (item 2), and a lost answer is recognised by
  (base + 1, SHA-256 of the outbox text); the same for the orphan.
- §4.1/§4.2: the CAS on the full round's lastSynced (item 3), which also retires a folded orphan.
- §3.1: item 5 (keyring_changed) and that the truncation is a SyncFlows method (item 4).
- §3.2/§3.5: item 6 (the approval path's added mode cannot dedupe).
- §4.3/D7: the `stuck` rule (item 10).
- §2.5: items 8 and 9.
- `sk_sync_state` gains the engine's members: `status`, `keyStatus`, `lastErrorCode` (a short snake_case code),
  `lastOkAt`, `lastAttemptAt`, `rejectedCheckedAt`, `pendingEnrollments`, `enrollSentAt`, `failures`, `backoffUntil`,
  `serverOffsetMs`, `devicesRev`, `devices` (ids and two flags), `keysSeen`, `kickAt`, `dirtySince`, `pendingRecoveryWrap`
  (`{fp, at, kver, baseKver, baseMac}`; `at` on the corrected clock, refreshed after each send), `notices`, `stuck`.
  `sk_sync_outbox` is `{v, base, head, from, checksum, envelope, proof}` (pushable) or `{v, from: null, checksum,
  envelope}` (merge-only, revision 20); `sk_sync_orphan` is `{v: 1, items}` of those records as they were kept, each with
  an optional `parked: {reason: "key" | "schema" | "too_large", vkId, at}`. `sk_sync_cfg.cursor` as §2.5.
- §4.2 step 1 / §3.14: the kill switch and registrations (item 20) and revoking (item 21).
- §3.8 P3 / §3.6.0: the rotation's base and its reconciliation, and what `not_synced` means (item 22).
- §3.6.0: the 10-minute rule (item 23).
- §4.8/§5.5: Retry-After is the floor, every 503 counts (item 24).
- §4.9: key operations hold `sixkey-sync` (item 12).
- The openapi's repair note (item 17) and, from the review, §4.2 step 1's "停止读写" now reaching the flows.

---

## 5. Measurements

### 5.1 Popup

- check-dist before M3: **53.8 KB gz** (static 49.9 + zh_CN 3.9). Revisions 1 and 2: the same, 51,077 static + 3,992
  catalog = **55,069 bytes** (check-dist's computation), and the built `dist/` byte-identical to main's.
- **Revision 3: 53.8 KB, 55,142 bytes (+73 B gz)**, static 50.0 KB + zh_CN 3.9 KB; check-dist OK. The dist is no longer
  byte-identical, because revision 19's hook lives in bundled code: `core/storage/store.ts` (the hook's placement over
  lost data), `core/sync/local/state.ts` (`recoveryHook`), `core/sync/local/keys.ts` (the key, `SYNC_OFF_KEYS`) and
  `core/sync/local/port.ts` (the wiring). The changed bytes: the shared chunk `assets/errors-*.js` 93,151 → 93,407 B
  (gzip 31,129 → 31,203) and `sw.js` 83,348 → 83,665 B (gzip 22,894 → 22,980); the popup, options, AddConfirm and importer
  chunks and both HTML pages differ only in the hashed name of that chunk (the same length). No new module, permission or
  network path; the engine is still out of the popup's module graph.
- **Revision 4: 53.9 KB, 55,187 bytes (+118 B gz over main, +45 B over revision 3)**, static 50.0 KB + zh_CN 3.9 KB;
  check-dist OK. The growth is the recovery hook's list append (`appendOrphan`, `core/sync/local/state.ts`): the hook is
  the one piece of the orphan list the popup carries. Revision 3 sat at 55,142 B, 0.4 B under check-dist's rounding to
  53.9 KB, so any growth shows. The changed bytes against main: `assets/errors-*.js` 93,151 → 93,503 B (gzip 31,129 →
  31,251) and `sw.js` 83,348 → 83,790 B (gzip 22,894 → 23,027); the other chunks differ only in that chunk's hashed name.
- **Revision 5: unchanged, 53.9 KB, 55,187 bytes**; check-dist OK. Nothing the build bundles changed (the delta is in
  the engine, `local/outbox.ts`'s parsers, `sync-local.ts` and `sync-flows.ts`, none in the popup's or the worker's
  graph yet): the built `dist/` is byte-identical to revision 4's (the same SHA-1 over every file).
- **Revision 6: unchanged, 53.9 KB, 55,187 bytes**; check-dist OK; the built `dist/` byte-identical to revisions 4 and 5
  (the same SHA-1 over every file): the new `keptAtTurnOff` in `local/state.ts` is tree-shaken out of every bundle, and
  the other changes are in modules no bundle carries yet.
- Wiring the outbox writer into the runtime's port (M5's step; a scratch build, not in the patch): revision 2 measured
  **+764 B**; revision 4, with the merge-only branch and the writer's own sync-off gate: **55,978 B, +791 B** over this
  revision's 55,187 (54.7 KB of 60 KB). The writer still makes one read (`sk_sync_state` with `sk_sync_cfg` in the same
  get, through `local/state.ts stateIfSyncOn`), and the merge-only record needs no crypto in the popup's commit (it copies
  the envelope text). With sync off it writes nothing (its callers gate on the sync context too).

### 5.2 Read budgets

- Sync off: `read-budget.test.ts` untouched and green (open 4, lock screen + unlock 7, degraded unlock 10); the popup does
  not load the engine.
- Sync on, the engine (`m3-read-budget.test.ts`, the service worker or the settings page):
  - sync off: the configuration and the sync state once each, the identity once; nothing written or sent;
  - the steady state, unlocked: one status request; 8 storage.local reads (`sk_sync_cfg`, `sk_sync_state` (the settle),
    the pointer, the slot, `sk_settings` (requireVk), then the engine's state, the guarded record, the rerun check), one
    IndexedDB read, nothing written (the attempt time at most every 30 s). Revision 2 reorders these reads (the vault
    before the state, M3R-1): the same eight, the pinned list in `m3-read-budget` changed order only;
  - locked, nothing to push: one status request, 9 storage.local reads, one IndexedDB read, nothing written;
  - revision 3: the engine's state read names `sk_sync_orphan` in the same `get` (the pinned list gains the key, the
    counts are the same); the recovery hook's one read and one write happen only at a recovery;
  - the throttle: a quiet round 10 s after the last state write writes nothing; one 35 s after it writes `sk_sync_state`
    once (the attempt and success times).

### 5.3 Tests

- New files: `test/unit/m3-{engine-units,engine-round,scenarios,keys,enroll,edges,repair,review,secrets,read-budget,source-rules,fake-server}.test.ts`,
  `test/fault/m3-{crash-round,crash-keys,faults,model}.test.ts`. Revision 2 added `m3-review` (39), the FakeServer's
  revision-15 block in `m3-fake-server` (8), the in-round recovery scenario of `m3-crash-round`, and the model's
  families.
- The whole suite in the copy (revision 2, over main's revision-17 tree): 98 files, 1,534 passed, 1 skipped (the skip is
  an existing one in `sync-crypto-adversary`), 2 min 22 s wall time on this machine; e2e 99 passed; typecheck, build and
  check-dist clean (the built `dist/` is byte-identical to main's: the same SHA-1 over every file); the three contract
  checks green (0 hard mismatches; 24 vector groups match; 40/40).
- **Revision 3** (over main's tree with SYNC-DESIGN revision 19 and contract revision 18): **104 files, 1,609 passed, 1
  skipped** (the same skip), 2 min 2 s; typecheck clean; e2e **99 passed** (6.0 min); build and check-dist OK (§5.1:
  53.8 KB, +73 B); the contract checks green (`check_consistency.py` 0 hard mismatches; `gen-vectors --check` 24 groups
  match; `test_contract.py` 42/42); `read-budget.test.ts`, `enable-crash` and `fault/store` unchanged and green. New
  files: `m3-orphan` (22), `m3-rereview` (22), `m3rr-probes` (15), `m3rr-fs-probes` (8), `m3rr-rotation-fuzz` (2: the
  re-review's six runs of 40 steps, and six with dirty tears), `m3rr-replay` (1).
- The model, revision 3: the `tear` family tears a **dirty** device (a save committed with its outbox written for the
  active generation, then the active slot torn), in twelve kinds, which map the design owner's list as follows:
  - dirty slot torn in "lock every time" (`lock_every_time`: the worker pushes or rounds without the key) and unlocked
    (`unlocked`, `popup_first`: the worker's round, or the popup's open first);
  - the orphan's push answered 409 (`orphan_push_409`: another device writes between the status and the PUT);
  - a double tear before the upload (`double_tear`), a local edit after the tear (`edit_after`), another device first
    with no push possible (`server_moved`);
  - a guard block on the fold (`purge`: the save is an erase; the review answered 70 % of the time, else later);
  - turn-off (`turn_off_rejoin`: turnSyncOff folds first, then a join by recovery key), the revoked device
    (`revoked_rejoin`: revoked elsewhere, removeSyncIdentity folds first, then the join), the join with an orphan (both
    rejoin kinds) and the cloud restore (`cloud_restore`: every copy lost, the restore keeps and folds it);
  - the checksum-equal orphan (`lost_pointer`: the save's pointer write lost, the self-check's recovery makes an orphan
    of the active generation itself, retired at the next fold; the kind asserts both);
  - not in the model, and why: R3 and FIXa2 with an orphan under a newer key need rotations, and the model's VK is fixed
    (R3 with tears is in the rotation fuzzer's second run; FIXa2, R3 and every other case have their own `m3-orphan`
    test); a damaged orphan is a save that is gone, which the model's oracle (nothing committed is lost) cannot accept
    (`m3-orphan` tests its removal).
  Runs outside the default size: families 120 × 70 (seed 4711) green with 290 dirty tears (every kind
  11–33 times); the plain model 200 × 80 (seed 99991) green; the rotation fuzzer 20 × 50 (seed 777) green in both
  variants (46 dirty tears among 34 rotations; `retryNotSyncedInEffect` 0). The rejoin kinds found the join's clamp on
  the uncorrected clock (§0c), fixed.
- **Revision 4** (over main's tree with SYNC-DESIGN revision 20; every run at low CPU, `nice -n 19`, two workers):
  typecheck clean; **108 files, 1,657 passed, 1 skipped** (the same skip), 8 min 17 s at two workers; e2e **99
  passed** (6.2 min); build and check-dist OK (§5.1: 53.9 KB, +45 B over revision 3); the contract checks green (0 hard mismatches;
  24 vector groups; 42/42); the live M4 harness on this tree 45/45. New: `m3-rev20` (14); adopted:
  `m3r3-review-probes` (18), `m3r3-review-crash` (2), `m3r3-review-phase0` (10). The model's `tear` family gains three
  kinds (fifteen in all), each from revision 20's §8.2: `elsewhere_then_push` (another device writes, the locked push
  demotes the stale outbox, then the tear: R3R-1), `save_during_push` (a second save in the popup while the worker's push
  of the first is in flight; the next push demotes it; the tear: R3R-1d) and `second_tear` (a tear, a save while the
  entry waits, written to the merge-only outbox, a second tear: R3R-5). Runs outside the default size, at low CPU: the
  families 120 × 70 (seed 4711) green with 259 dirty tears (every kind 9–29 times; the three new kinds 10, 22 and 15);
  the plain model 200 × 80 (seed 99991) green; the rotation fuzzer 20 × 50 (seed 777) green in both variants (58 dirty
  tears among 33 rotations; `retryNotSyncedInEffect` 0).
- **Revision 5** (every run at `nice -n 19`, two workers): typecheck clean; **111 files, 1,685 passed, 5 expected fail,
  1 skipped** (the same skip; the five expected failures are the recorded findings' probes, §B), 8 min 30 s; build and
  check-dist OK, the `dist/` byte-identical to revision 4's (§5.1), so e2e was not run again (revision 4's 99 passed ran
  on this same bundle; the CPU limit); the contract checks green (0 hard mismatches; 24 vector groups match; 42/42).
  Adopted: `m3r4-review-probes` (21: 16 plain, 5 `it.fails`), `m3r4-review-killers` (6), `m3r4-review-crash` (5);
  `m3-rev20` 15 (one new). 1,657 + 27 + 1 = 1,685.
- **Revision 6** (every run at `nice -n 19`, two workers; the whole suite once): typecheck clean; **113 files, 1,702
  passed, 5 expected fail, 1 skipped** (the same skip and the same five recorded probes, §B), 8 min 43 s; build and
  check-dist OK, the `dist/` byte-identical to revision 5's, so e2e was not run; the contract checks green (0 hard
  mismatches; 24 vector groups match; 42/42). Adopted: `m3r5-review-probes` (8), `m3r5-review-killers` (3); `m3-rev20`
  21 (six new: four for the approval join, two for the turn-off and the live outbox); `m2-sync-local` one case added in
  an existing test. 1,685 + 8 + 3 + 6 = 1,702.
- The model (`m3-model`): 40 seeded runs of 60 steps by default (`SIXKEY_M3_RUNS`, `SIXKEY_M3_STEPS`, `SIXKEY_M3_SEED`);
  run once at 600 × 70 green. Revision 2 adds the review's families on four devices (clocks 0, +2 d, −2 d, +3 h): `tear`
  (a slot torn after a synced round, then a worker round, or the popup first), `hook` (inside the device's own PUT: an
  edit there, another device's write, another context's load) and `pw` (password changes, a third with the answer lost);
  15 × 50 by default (`SIXKEY_M3_FAMILY_*`), run once at 120 × 70 green; no PITR with tears (the review's harness
  lesson: a tear and a rollback together are a double failure).
- The crash matrices: a round (five operations: a full round, the locked outbox push, a round answered 409, M2's
  storage recovery followed by an edit and a round, and the recovery inside a worker round's own load; × every step ×
  before/after/lie × worker/browser restart) and the key operations (three × every step × before/after; `offline` and
  `not_synced` count as outcomes the user is told).

---

## 6. M1/M2 code changed, and existing tests changed

- `src/core/service/sync-flows.ts` (M2): the methods of §1.1 (the brief's §3.1 items and the engine's per-round
  accessors). Nothing existing changed in behaviour; `FlowAccess.committed` gains `session?` in its type (it was already
  passed through).
- `test/unit/m2-source-rules.test.ts`: the "heavy import" rule's allowed importers gain `core/sync/engine/` (the engine
  builds on the flows and the local side by design). The guards that matter are added in `m3-source-rules`: nothing
  outside the engine imports it, and the popup's module graph has no engine module and not the outbox writer. No
  assertion weakened otherwise.
- Revisions 1 and 2 changed no M1 code. `enable-crash`, `fault/store` and every other existing test are unchanged in every
  revision. The contract files (`contract/`, `api/openapi.yaml`, `test/helpers/contract.ts`, `contract-openapi.test.ts`)
  are main's, read-only here.
- **Revision 3 (design revision 19, the orphan; all bundled, hence §5.1's +73 B):**
  - `core/sync/local/state.ts` (M2): `recoveryHook()`, the store's hook (lastSynced cleared, the outbox moved to
    `sk_sync_orphan` in the same write, an orphan already there kept). `clearLastSynced()` and `clearingItems` unchanged:
    the shared clear still deletes only the live outbox.
  - `core/sync/local/port.ts` (M2): the port's `clearLastSynced` (the store's `beforeRecoveryWrite`, its one caller) runs
    `recoveryHook()`.
  - `core/sync/local/keys.ts` (M2): `SYNC_KEYS.orphan`, and `sk_sync_orphan` in `SYNC_OFF_KEYS`.
  - `core/storage/store.ts` (the hook M2 added to M1's store): over lost data the hook now runs before the caller's
    function instead of after it (§3 item 25); the header comment says so. `fault/store` and the M1 store tests are
    unchanged and green.
  - `core/service/sync-flows.ts` (M2, not bundled in the popup): `JoinInput.refNow?`, the server-corrected time the
    enrolment learned; `prepareJoin` clamps on it when given (else the stored offset, as before). Found by the model's
    rejoin kind (§0c); tested in `m3-rereview`.
  - `test/helpers/faulty-transport.ts` (M3's): `clearRules()`, for the model's flows that run on a working network.
  - Existing tests whose expectation changed with the design (none loosened; each asserts the new rule, and the new
    behaviour keeps more data than the old):
    - `test/unit/m2-sync-local.test.ts`: the key table gains `orphan`; a new test for `recoveryHook` (moved in one write,
      an existing orphan kept, `clearLastSynced` never touches it).
    - `test/regression/m2-store.test.ts`: the wired-hook test expects one write of state + outbox + orphan with the
      outbox moved (it expected the outbox deleted); a new test for the hook's placement over lost data (it runs before
      the caller's function; a throwing function leaves the hook's state and writes nothing else).
    - `test/unit/m3-review.test.ts`: R1b (the locked worker now pushes the orphan and the save reaches every device; it
      asserted that the cleared outbox was not pushed); M3R-9's 410 test (the rejoin is first refused `unfinished_wait`,
      then goes ahead after the window: M3RR-7); M3R-14's write_denied test (now a real key move between the PUT and the
      status, needs_password, no failure counted; a new test for the persistent write_denied: M3RR-10); M3R-15's
      429 test (an explicit press outside a running backoff is counted once: M3RR-2).
    - `test/unit/m3-read-budget.test.ts`: the pinned reads name `sk_sync_orphan` in the engine's state read.
    - `test/unit/m3-fake-server.test.ts`: the Content-Type cases follow M4 exactly (FS-1).
    - `test/helpers/m3-model.ts`: the `tear` family tears a dirty device (twelve kinds, §5.3) instead of a clean one; the
      model's other checks unchanged (a `watchProblems` option for the replay test only).
- **Revision 4 (design revision 20):**
  - `core/sync/local/state.ts` (M2, bundled: §5.1's +45 B): `recoveryHook()` appends to the list (`appendOrphan`, also
    used by the engine's demotion); a stored value that is not a list is kept as an entry.
  - `core/sync/local/outbox.ts` (M2's local side, M3's file; not wired: M5): the merge-only outbox and the over-limit rule
    (§0.1); the list's types and parsers (`OrphanItem`, `parseOrphanList`, `sameEntry`); the writer returns at once with
    sync off (no `sk_sync_cfg`), reading it with the state in one get (`local/state.ts stateIfSyncOn`, tree-shaken out of
    the popup).
  - `test/unit/m3-source-rules.test.ts` (M3's): the outbox writer no longer names `sk_sync_state` itself (it reads it
    through `stateIfSyncOn`), so the list of files that name it is one shorter.
  - `core/sync/local/sync-local.ts` (M2, not bundled): `turnOff` keeps the list's parked entries (D11 deletes the key only
    when none is left), in the same vault-and-identity critical section as before.
  - `core/sync/local/keys.ts`, `port.ts` (M2): comments only.
  - Existing tests whose expectation changed with the design (none loosened):
    - `m2-sync-local`: the hook test asserts the append (a second entry, a merge-only one, a non-list value kept); a new
      test for `turnOff` keeping parked entries.
    - `m2-store` (both hook tests): the outbox appended to the list (`{v: 1, items: [...]}`).
    - `m3-engine-units`: "without lastSynced nothing is written" became the merge-only outbox; a new test for the size
      skip.
    - `m3-faults` "after a join or a key commit an edit writes no outbox": a merge-only outbox, never pushed, removed by
      the full round.
    - `m3-orphan`: the records planted are wrapped in the list; the newer-schema test asserts parking (lastSynced set,
      rounds stop pulling, the pushable outbox back, the rotation done) instead of "lastSynced stays null".
    - The third review's probes: as §0b says (the list wrapping, R3R-3's and R3R-4's new assertions, R3R-5's
      precondition).
  - `test/helpers/m3-model.ts`: three more tear kinds (§5.3); `elsewhere_then_push`, `save_during_push`, `second_tear`.
- **Revision 5 (the fourth review; nothing bundled in the popup changed, so §5.1 is unchanged):**
  - `core/sync/local/sync-local.ts` (M2, not bundled): **`turnOff` CHANGED its rule.** Revision 4 kept the entries with a
    parked mark and deleted every other one; revision 5 takes `{ folded }`, the entries the calling flow folded into the
    vault, and keeps every other entry (parked, never tried, appended meanwhile), in the same vault-and-identity critical
    section. A stored value that is not a list is read as one entry. `turnOff()` with no argument keeps everything.
  - `core/service/sync-flows.ts` (M2, not bundled): `SyncLocalPort.turnOff(o?)`, `turnOffSync(o?)` pass `folded` through;
    nothing else.
  - Existing tests whose expectation changed (none loosened; each new expectation keeps more data than the old):
    - **`m2-sync-local` "turnOff (D11 ...)": the test that pinned revision 4's rule ("keeps the parked entries", where an
      unmarked entry went) is rewritten to the new one**: the folded entry goes, a parked one AND an unmarked one stay;
      `turnOff()` keeps every entry; all folded, the key goes; a non-list value is kept as one entry.
    - `m3-rev20`: the summaries assert `checksums` too (`toMatchObject`/`toEqual`); the sync-off fold test keeps its
      case as it was (the only entry folds: `{ folded: 1, parked: 0 }`, the key gone) and gains one (RV4-21: a second
      openable entry beside a still-parked one: `{ folded: 1, parked: 1 }`, the parked one stays); a new test for R4R-5
      in the locked round. Nothing removed.
    - The fourth review's files: the edits §0a lists (five `it.fails`, one `toEqual` with `checksums`, a header comment).
- **Revision 6 (the fifth review; nothing bundled in the popup changed in behaviour, §5.1):**
  - `core/sync/local/sync-local.ts` (M2, not bundled): **`turnOff` CHANGED again**: besides keeping every orphan entry the
    flow did not report folded, it moves the live outbox into the list unless the active slot on disk provably holds it
    (`checkGeneration` passes and the envelope checksum is the outbox's); the slot is read inside the turn-off's lock. The
    test is exact against the store: `load()` returns the pointer's slot whenever it passes `checkGeneration`, and
    `recover()` (the fallback, the key-change rollback, which keeps the pointer's slot too) runs only otherwise.
  - `core/sync/local/state.ts` (M2, bundled but tree-shaken): `keptAtTurnOff`, the turn-off's keep rule (moved here from
    `sync-local.ts` so that `sk_sync_outbox` stays named only by its writers, the source rule of M2-NOTES §7 item 6).
  - `core/sync/local/keys.ts` (M2): comments only.
  - `core/sync/engine/enroll.ts`, `state.ts`, `orphans.ts` (M3): `foldForJoin` in both joins and the approval prepare;
    the "Advanced" checksums required.
  - Existing tests whose expectation changed (none loosened; each keeps more data or checks more):
    - `m2-sync-local` turnOff: a case added (the live outbox with no intact active slot is moved into the list).
    - `m3-rev20` "'Advanced'": the calls pass the checksums; two refusals added (a count that disagrees with them; none).
    - `m3r4-review-probes` R4R-8 and `m3r4-review-crash`'s "Advanced" test: the checksums passed (flagged, §0), so each
      still reaches the code it tests.

---

## 7. Mutation results

**Revision 6** (the fifth review; `scratchpad/m3/scripts/mut6.py`, the same runner on a frozen copy of this tree, ONE
mutant at a time at `nice -n 19` with two workers; tier 1 gains the fifth review's probes, tier 2 its killers, which hold
the 50 000-entry test): **17 mutants, 16 killed, 1 equivalent**; none by `tsc` or a timeout.

| Fix or survivor | Mutants | Killed by (first failing test) |
|---|---|---|
| R5R-1: the joins refuse a locked fold | R6-01 `foldForJoin` never refuses (revision 5's behaviour) | `m3-rev20` "a locked start with an unparked entry … refuses (locked) before anything is sent or written" (the start resolved instead; confirmed alone with `scripts/mut6-solo.py`). Without that test it survived every tier: the prepare's second fold and `prepareJoin`'s own key check keep the data safe, so the refusal at the start is what the test pins |
| R5R-1: the approval prepare folds again | R6-02 no second fold | `m3-rev20` "an unparked entry that came after the start" |
| R5R-1: the recovery-code join | R6-03 `joinWithRecoveryCode` back to the plain fold | **survived every tier and the whole suite: equivalent in every case a test can make.** `prepareJoin` needs the local key and refuses `locked` itself, right after the fold, with the same code. The one difference is a lock that lands inside the fold and is lifted again before `prepareJoin`; then the plain fold would let a join go on that the lock check stops. Kept for the two joins to behave alike |
| R5R-2: the turn-off keeps the live outbox | R6-04 the outbox deleted again; R6-05 kept even when the active slot holds it; R6-06 "holds it" read from the raw checksum field, without the integrity check | `m3-rev20` "the active slot fails its integrity check …" (R6-04, R6-06); `m3-rev20` "an entry parked under a newer key, folded after the adoption …" (R6-05: its "no sk_sync key but the list" assertion; run alone, the "intact slot" test kills it too) |
| R5R-3: the checksums required | R6-07 a count without checksums accepted again; R6-08 the count ignored (revision 5's R5-10, re-anchored); R5V-10 the checksums ignored (re-anchored) | `m3-rev20` "'Advanced' …" (R6-07, R6-08); R5R-3 (R5V-10) |
| the code the fixes touched or moved (re-run, re-anchored into `keptAtTurnOff` where it moved) | R5-01 keeps by the parked mark; R5V-02 keeps every entry; R5V-15 drops a non-list value; R4-20 deletes the kept entries; R5-03 the turn-off claims every entry folded; R5V-16 the revoked-pending undo claims every entry folded; R5-09 "Advanced" without the re-read; RV4-20 "Advanced" deletes unparked entries | the fifth review's "after resumeFirstUpload's undo …" (R5-01, R4-20); `m3-rev20` "an entry parked under a newer key …" (R5V-02); `m2-sync-local` turnOff (R5V-15); R4R-3 (R5-03); the R5V-16 killer (tier 2); R4R-8 (R5-09, with its checksums now passed); `m3-rev20` "'Advanced'" (RV4-20) |

Results: `scratchpad/m3/mut6-results.json` (log `mut6-run.log`). A first run was stopped after R6-01 had survived tiers 1
and 2 (the start-refusal test did not exist yet); the tree was frozen again with it and every mutant run from the start.

**Revision 5** (the fourth review; `scratchpad/m3/scripts/mut5.py`, the same runner as revision 4 on a frozen copy of
this tree, ONE mutant at a time at `nice -n 19` with two workers; tier 1 gains the review's probes and killers, tier 2 its
crash matrix): **31 mutants, 31 killed**, none by `tsc`, none by a timeout, all in tier 1.

| Fix or survivor | Mutants | Killed by (first failing test) |
|---|---|---|
| R4R-1: `turnOff` keeps what was not folded | R5-01 keeps entries by the parked mark again (revision 4's rule); R4-20 deletes the kept entries with the records (re-anchored) | R4R-1 (both) |
| R4R-2: the vault before the list | R5-02 `foldForFlow` reads the list before the vault | R4R-2 |
| R4R-3: an entry appended during the revoke | R5-03 the turn-off reports every entry in the list as folded | R4R-3 |
| R4R-4: one reading | R5-04 a non-list value read as damaged by the fold again | R4R-4 |
| R4R-5: a newer format parked | R5-05 read as damaged; R5-06 the fold opens it; R5-07 the locked round judges it "another vault" | R4R-5 (R5-05, R5-06); `m3-rev20` "a newer build's record … in the locked round" (R5-07) |
| R4R-7: sync off only | R5-08 `foldParkedLocally` runs with sync on | R4R-7 |
| R4R-8: "Advanced" in one critical section | R5-09 no compare-and-set; R5-10 the count ignored (revision 4's R4-23, re-anchored into `discardParked`); RV4-20 deletes unparked entries too (re-anchored) | R4R-8 (R5-09); `m3-rev20` "'Advanced' …" (R5-10, RV4-20) |
| R4R-14: a union over the limit parked | R5-11 the combination not checked (the fold throws again); R4-18 a fold over the limit not parked | R4R-14 (both) |
| the code the fixes touched (re-run) | R4-21 the flows refuse for parked entries; R4-22 the sync-off fold keeps what it folded; R4-24 a lost vault reported as locked; R4-25 `foldForFlow` takes a lost vault for a locked one; R4-26, R4-27 the undos fold without the join's answer; RV4-11 the locked round removes every entry when the vault is lost; RV4-22 `orphanLockedOut` ignores what was folded; RV4-23 it lets a flow go ahead with a lost vault | `m3-rev20` (R4-21, R4-22, R4-26, R4-27); R3R-3 (R4-24, R4-25, RV4-23); RV-23's killer (RV4-11); R4R-2 (RV4-22) |
| R4-14 (R4R-13: not equivalent) | R4-14 the CAS beside an unparked entry it did not fold | the review's "R4-14 killer" |
| R4-29 (the HLC tie) | R4-29 the entries combined unclamped | in the tier run first by R4R-6's `it.fails` probe (the mutant makes it pass); run alone against the review's "R4-29's tie (killer)" it is killed by that test too (`scripts/mut5-solo.py`) |
| the review's six survivors | RV4-07, RV4-13, RV4-14, RV4-19, RV4-21, RV4-24 | the review's killers, each its own; RV4-21 also killed by `m3-rev20`'s sync-off fold test run alone (its added case) |

Results: `scratchpad/m3/mut5-results.json` (logs `mut5-run.log`, `mut5-run2.log`). The earlier mutants on code revision 5
did not change were not re-run (the maintainers' CPU limit); the ones on changed code are in the table.

**Revision 4** (design revision 20; `scratchpad/m3/scripts/mut4.py`, ONE mutant at a time at low CPU: a fresh copy of the
frozen tree, the exact replacement, `tsc --noEmit`, tier 1 = the twelve orphan/outbox test files with `--bail 1`, a
survivor then tier 2 = eleven fault, model and flow suites, a survivor of both the whole suite): **32 mutants of the new
logic, 29 killed, 3 not**. At least one per rule of revision 20:

| Rule | Mutants | Killed by (first failing test) |
|---|---|---|
| demote, never drop (R3R-1) | R4-01 409 drops; R4-02 a stale (base, head) drops; R4-03 write_denied with the key moved drops; R4-04 a demotion overwrites the list; R4-05 a demotion keeps lastSynced | R3R-1b; R3R-1; `m3-rev20` "the third demotion case" (written for R4-03, which survived the first pass); `m3-rev20` "a demotion beside a parked entry" (for R4-04, likewise); `m3-rev20` "a demotion, a merge-only outbox and two recoveries" |
| the list (R3R-5, the hook) | R4-06 the hook overwrites the list; R4-07 the hook appends only pushable outboxes | `m3-rev20` "a demotion, a merge-only outbox and two recoveries" (both) |
| the merge-only outbox (R3R-5) | R4-08 none written (revision 19's writer); R4-09 the full round keeps it; R4-10 the locked push takes any pushable entry by version alone; R4-30 the writer writes with sync off | R3R-5 (rerun on the final tree; `m3-rev20` three entries before); `m3-faults` "after a join or a key commit" (tier 2); `m3-orphan` "not pushed when the server is at its base version with another head"; `m3-rev20` "no outbox of any kind … while sync is off" |
| the fold over the list | R4-11 only the first entry folded; R4-12 no checksum-equal retirement; R4-29 the entries combined unclamped | `m3-rev20` (three entries); `m3-orphan` "a damaged orphan … the active generation itself"; **R4-29 survived** (below) |
| parking and the CAS (R3R-4) | R4-13 the CAS retires parked entries; R4-14 the CAS beside an unfolded unparked entry; R4-15 parked entries hold sync up; R4-16 newer schema not parked; R4-17 a key not held not parked; R4-18 too_large not parked; R4-19 orphan_unreadable without the "listed" check (RV-18) | `m3-orphan` (the parked newer-schema test, R4-13/15/16); `m3-orphan` "under a key no keyring here lists" (R4-17); RV-08's killer (R4-18); **R4-14 and R4-19 survived** (below) |
| the record-deleting flows (R3R-2) | R4-20 turn-off deletes parked entries; R4-21 the flows refuse for parked entries; R4-22 the sync-off fold keeps what it folded; R4-23 "Advanced" without the confirmed count; R4-28 the parked mark never cleared | R3R-2b; R3R-2a; `m3-rev20` (the sync-off fold; "Advanced"); `m3-rev20` "no longer parked: turning sync off right then deletes it" (for R4-28, which survived the first pass) |
| vault_lost (R3R-3) | R4-24 reported as locked; R4-25 foldForFlow takes a lost vault for a locked one | R3R-3 (both) |
| the undo's answer (R3R-6) | R4-26 M3R-9's undo folds without it; R4-27 the revoked-pending undo folds without it | `m3-rev20` (M3R-9's undo); `m3-rev20` "the revoked-pending undo" (for R4-27, which survived the first pass) |
| the third review's survivors | RV-08 a too_large fold removes the entry; RV-19 the approval join without refNow | `m3-orphan` RV-08 killer; `m3-rereview` the approval join's clock |

Not killed:
- **R4-14 (equivalent in reachable states; WRONG, the fourth review's R4R-13: a fold that ends `locked` folds nothing and
  the round can still reach the no-upload CAS; killed in revision 5 by the review's killer).** An unparked entry the round did not fold can only appear between the fold
  and the CAS if something appends one meanwhile: a recovery (it changes the active generation, so the CAS's checksum
  check refuses) or a demotion (it needs `sixkey-sync`, which the round holds). The one recovery that keeps the active
  checksum (a rebuild of the same generation) appends an entry of that very generation, retired by the next fold
  (retirement 3). The check stays as a second line.
- **R4-19 (RV-18: not reachable).** A parked "key" entry whose key IS listed needs a previous-key entry the current key
  cannot unwrap; no code writes one (`rekey` re-wraps what it can open and drops the rest), and keyStatus `ok` needs the
  server's bundle to carry the same corrupted entry.
- **R4-29 (survived; a tie-break; killed in revision 5 by the review's "R4-29's tie" test).** Clamping each entry before combining them differs from clamping the combination only
  when one account is edited in two entries with both stamps past the 24 h limit: both are then clamped to the same
  wall time and the HLC tie-break (counter, device suffix) picks the winner instead of the larger raw stamp. No test pins
  that tie; the code follows §4.7's `merge(clamp(本地), clamp(条目₁), …)`.

Results: `scratchpad/m3/mut4-results.json` (logs `mut4-run.log`, `mut4-rerun.log`). The 138 mutants of revisions 1–3 and
the re-review's 26 were not re-run in full this round (the maintainers' CPU limit); the ones on the code revision 20
replaced (R3-01 to R3-16, R3-36, R3-38: the single orphan) are superseded by R4-01 to R4-29, and the suite they ran
against only grew.

**Revision 3** (the final tree; the runner outside the patch, as before: a fresh copy of the tree, the exact
replacement, `tsc --noEmit`, the M3 test files with `--bail 1` (now 24 files: the 16 of revision 2, the six new ones,
`m2-sync-local` and `m2-store`), then the whole suite for a survivor; three in parallel):
- **mine: 138 mutants, 136 killed, 2 equivalent.** The 99 of revision 2 (twelve re-anchored on the revision-3 code with
  the same mutation: M3-16, M3-18, MR-28, MR-30, MR-31, N-01, N-02, N-03, N-10, N-12, N-16, N-17), and 39 new ones
  (R3-01 to R3-38 and R3-13b), one or more per fix: the orphan (R3-01 to R3-16, R3-36, R3-38), M3RR-1 (R3-17 to
  R3-20), M3RR-2 (R3-21, R3-22), M3RR-4 (R3-23, R3-24), M3RR-5 (R3-25), M3RR-6 (R3-26), M3RR-7/8 (R3-27 to R3-30),
  M3RR-9 (R3-31, R3-32), M3RR-10 (R3-33), FS-1 (R3-34), M3RR-12 (R3-35), the join's clock (R3-37).
  - Equivalent: MR-15 (as in revision 2, below) and **R3-13b** (the turn-off without its "locked with an orphan"
    refusal): `turnSyncOff`'s `context()` already refuses a locked vault (`locked`) before anything is revoked or
    deleted, so the refusal is a second, defensive line.
  - Five survived the first pass and got their test: R3-02 (`m2-sync-local`: never a second orphan over the first),
    R3-04 (`m3-orphan`: the D5 head check on the orphan's push), R3-09 (`m3-orphan`: no `orphan_unreadable` while the
    keys are not confirmed), R3-21 (`m3-rereview`: a 503 counts inside a running backoff), R3-32 (`m3-rereview`: a fresh
    worker's push signed on the stored offset); after the last code change, R3-16 and R3-19 (`m3-orphan`: the locked
    removeSyncIdentity; `m3-rereview`: an unknown rotate retried offline). Seven of the new mutants were first written
    with `Date.now()` as their "false" and were killed by the engine's source rule (no clock in the engine) instead of a
    behaviour; they were rewritten without it and killed by behaviour (M3-16, R3-10, R3-14, R3-17, R3-20, R3-30,
    R3-36). One kill came from the whole suite (M3-02, M2's own snapshot test, as in revision 2); none from a timeout.
- **the re-review's 26 (`scratchpad/m3rr-scripts/mut.py`, retargeted to the frozen tree as `scratchpad/m3/scripts/rr-mut.py`;
  eleven anchors re-placed on the revision-3 code with the same intent: MY-01, -03, -04, -06, -08b, -10, -11, -12, -14,
  -16, -22): 23 killed, 3 not:** MY-02 equivalent (as the re-review says: `current()` loads, and recovers, before
  `requireVk` throws); MY-20 masked (the "the local key changed meanwhile" check now runs after the "the server's keys
  moved" reconciliation, which every reachable case of it meets first: a local key change is committed only after the
  server accepted it); MY-22 near-equivalent (as the re-review says). MY-12 survived the first pass (only an explicit
  429 inside a backoff is still "not counted" now, and no test asked for its Retry-After): `m3-rereview` now does.
  The ten the re-review left alive are killed by `m3-rereview` "the re-review's surviving mutants" and the adopted
  probes.
- Results: `scratchpad/m3/mut-results-r3-merged.json`, `rr-mut-results-r3-merged.json` (logs `mut-run-r3-final.log`,
  `rr-mut-run-r3.log`, and the reruns in `mut-results-r3-next.json`, `rr-mut-results-r3-next.json`).

| # | The bug | Killed by | First failing test |
|---|---|---|---|
| M3-01 | upload before merge (the remote is never merged) | m3 tests | `m3-review`: a worker round right after the active slot is torn pulls and merges first: the head keeps X, and every device  |
| M3-02 | merge without the pre-merge snapshot | full suite | `regression/m2-service`: merges both sides in one save: rev+1, the same keyring byte for byte and no marker (§0.0i item 2, revision 12: |
| M3-03 | rollback not detected (needPull ignores the head, D5) | m3 tests | `m3-scenarios`: D5: after a rollback another device reuses the same version number with other content; this device pulls becau |
| M3-04 | equal-version replay accepted (outbox pushed on the version alone) | m3 tests | `m3-faults`: D5: after a rollback another device reused the outbox's version with another head: the outbox is never pushed  |
| M3-05 | newer_schema skipped in the history walk (R6) | m3 tests | `m3-scenarios`: R6 during the walk: the head does not open, the version below it is schemaVersion 2: stop, never merge an olde |
| M3-06 | a newer-schema head walked past (R6) | m3 tests | `m3-scenarios`: R6: a schemaVersion 2 head pauses (paused_newer): nothing uploaded, the outbox kept, the local vault unchanged |
| M3-07 | guard bypassed when no answer is given | m3 tests | `m3-orphan`: a guard block on the fold: review_needed, the orphan kept; the answer folds it, and the round retires it |
| M3-08 | outbox dropped before a push that may fail | m3 tests | `m3-edges`: the PUT never reached the server: the outbox stays and the next wake pushes it |
| M3-09 | outbox kept after it was pushed (applied twice) | m3 tests | `m3-faults`: delivered after the worker gave up (late), then pushed again: still exactly one version with it |
| M3-10 | HLC not clamped in the merge | m3 tests | `m3-edges`: a remote entry stamped 10 days ahead is stored clamped to now + 24 h, so an edit made here an hour later still |
| M3-11 | dirty not tracked by the envelope checksum | m3 tests | `m3-review`: a worker round right after the active slot is torn pulls and merges first: the head keeps X, and every device  |
| M3-12 | settlePins skipped before the key decision | m3 tests | `m3-edges`: PROBE-2: this device changed the password and IndexedDB refuses the pin writes; the next round still finds the |
| M3-13 | a stale capability committed again | m3 tests | `m3-edges`: another context adopts a newer bundle between this round's verdict and its commit: refused as stale, evaluated |
| M3-14 | noSync ignored by the truncation | m3 tests | `m3-keys`: refused with sync_on, nothing written |
| M3-15 | first-upload pins without the local-keyring check | m3 tests | `m3-edges`: after the 201: the local keyring is no longer the one sent; no "in sync" pins, and nothing reverts the other t |
| M3-16 | a round in cfg_missing | m3 tests | `m3-enroll`: storage.local wiped, IndexedDB (the identity and the mirror) kept… and the mirror too: the cloud restore (§4.1 |
| M3-17 | the clone cursor sent on status polls | m3 tests | `m3-enroll`: end to end: the new device joins, completes and pulls; its row says approval, approved_by the approver |
| M3-18 | 409 retried without re-pull (blind re-upload over the newer head) | m3 tests | `m3-crash-round`: a round whose PUT is answered 409 (the head moved meanwhile), then merges and uploads again, then a worker res |
| M3-19 | backoff unbounded | m3 tests | `m3-faults`: the backoff is bounded however long the server keeps failing (30 min ± 20 %), and failures are only a number |
| M3-20 | lastSynced CAS ignores the active generation (D1) | m3 tests | `m3-crash-round`: a full round: pull, merge, upload, then a worker restart |
| M3-21 | the outbox push revives lastSynced after a recovery (D2) | m3 tests | `m3-scenarios`: a recovery between the commit and the push: the push does not bring lastSynced back (the hook cleared it), the |
| M3-22 | the server offset not clamped to ±7 days | m3 tests | `m3-engine-units`: the offset at the exchange's midpoint, used within ±7 days |
| M3-23 | min_client_version ignored | m3 tests | `m3-review`: below min_client_version: no password change, no new code, no rotation, no approval, no adoption; rejecting an |
| M3-24 | a rejected device deletes its identity (P5) | m3 tests | `m3-review`: revoked, then un-revoked by an honest rollback: two days of 30-minute wakes ask the server once a day, and the |
| M3-25 | the password change committed locally before the server accepted it | m3 tests | `m3-crash-keys`: change the master password |
| M3-26 | a keys_conflict taken as success without reconciliation | m3 tests | `m3-edges`: another device changed the keys before this one sent: changed_elsewhere; nothing committed; the shown code is  |
| M3-27 | the new code's fingerprint not kept before sending | m3 tests | `m3-review`: every PUT /v1/keys failed before delivery: unconfirmed; once no signature of it can land, a round says not in  |
| M3-28 | the resumed first upload pinned without the keyring check | m3 tests | `m3-edges`: after the 201: the local keyring is no longer the one sent; no "in sync" pins, and nothing reverts the other t |
| M3-29 | the rotation leaves the device names under the old key | m3 tests | `m3-keys`: rotate: the server's key, K_write and every device name (revoked too) move to VK2; the other device needs the  |
| M3-30 | the outbox written while lastSynced is null | m3 tests | `m3-faults`: after a join or a key commit (lastSynced cleared) an edit writes no outbox until a full round |
| M3-31 | a quiet round writes the state every time | m3 tests | `m3-read-budget`: the attempt time is written at most every 30 s: a quiet round 10 s after the last write writes nothing, one 35 |
| M3-32 | the stuck memo ignores a local edit | m3 tests | `m3-scenarios`: D3: a merge over 8 MiB is committed locally, the upload pauses (too_large); deleting into the trash and erasin |
| M3-33 | a kick not persisted (a stopped worker forgets it) | m3 tests | `m3-faults`: a local edit asks for a round 3 s later (setTimeout) and a 30 s backstop (alarm), persisted for a restarted wo |
| M3-34 | wake ignores the backoff | m3 tests | `m3-faults`: 429 and 503 with Retry-After: the next try is not before it; wake() inside the backoff does not run a round |
| M3-35 | a rotated server merged instead of needs_password (R4) | m3 tests | `m3-rereview`: a lost rotate, then another device's key change wins: the retry says changed_elsewhere (never not_synced), the |
| M3-36 | the pin moved back to the local keyring (D8 second direction) | m3 tests | `m3-keys`: the double fault: the server also went back to VK1: needs_password stays, the vault works locally, nothing is  |
| M3-37 | the D7 too-large merge retried as a failure (backoff loop) | m3 tests | `m3-scenarios`: D7: a merge past 50 000 entries is not committed and becomes too_large (not retried every round); the local va |
| M3-38 | the review's digests written to sk_sync_state (C1: nothing of a blocked merge kept) | m3 tests | `m3-scenarios`: a remote that erases an account alive here stops the merge (review_needed), keeps nothing; [Apply] after revie |
| M3-39 | the lost-answer push not recognised (outbox dropped instead) | m3 tests | `m3-faults`: delivered after the worker gave up (late), then pushed again: still exactly one version with it |
| M3-40 | identity_missing not restored once unlocked | m3 tests | `m3-enroll`: IndexedDB deleted before every start (GoLogin): restored from its copy after unlock, no new device row, no app |
| M3-41 | review_needed pushes the local vault over the head (Keep mine without asking) | m3 tests | `m3-orphan`: a guard block on the fold: review_needed, the orphan kept; the answer folds it, and the round retires it |
| M3-42 | the guard skipped on one branch: an adoption's merge (commitKeys with the new key's data) | m3 tests | `m3-edges`: adopting a rotation with the password: the new key's data would erase an account alive here; review_needed, no |
| M3-43 | the guard skipped on one branch: a rejoin's merge (prepareJoin, the same vault) | m3 tests | `m3-edges`: a rejoin by recovery key into the same vault: the cloud would erase an account alive here; MergeBlocked, the  |
| MR-01 | the round uploads the pre-merge local vault (push before merge in the merge branch) | m3 tests | `m3-crash-round`: a full round: pull, merge, upload, then a worker restart |
| MR-02 | a locked push answered 409 is acknowledged as pushed (outbox acked before a verified 200) | m3 tests | `m3-review`: MR-02: a locked push answered 409 is dropped, never taken as pushed: lastSynced names only what the server hol |
| MR-03 | lastSynced CAS ignores the lastSynced the round began with (generation of the CAS) | m3 tests | `m3-engine-units`: lastSynced moves only by CAS: the active generation must still be the one, and lastSynced still what the round |
| MR-04 | a lost locked push recognised by the version alone (another device's base+1 taken for ours) | m3 tests | `m3-review`: MR-04: an outbox push that never arrived is not taken as landed because the server is at base + 1 (another dev |
| MR-05 | guard threshold off by one (one changed secret passes without asking) | m3 tests | `m3-review`: MR-06: a remote that changed a secret but carries an older stamp still stops the merge (review_needed); nothin |
| MR-06 | engine skips applyRemote (and its guard) when the merge leaves the local vault as it is | m3 tests | `m3-review`: MR-06: a remote that changed a secret but carries an older stamp still stops the merge (review_needed); nothin |
| MR-07 | newer_schema treated as damage when opening a remote (walk instead of pause) | m3 tests | `m3-engine-units`: ok; another vault; another key (R5); a bad checksum; a newer schema (R1/R6); garbage |
| MR-08 | applyRemote leaves the remote unclamped (a future stamp wins) | m3 tests | `m3-edges`: a remote entry stamped 10 days ahead is stored clamped to now + 24 h, so an edit made here an hour later still |
| MR-09 | needUpload compares with the clamped remote, not the raw one (F5) | m3 tests | `m3-review`: F5 end to end (MR-09): a remote stamp days ahead reaches the server clamped, and a real edit two days later wi |
| MR-10 | an unreadable head that the walk repaired is not overwritten (headUnreadable ignored) | m3 tests | `m3-faults`: an envelope whose header was changed and its checksum recomputed (the checksum is right, the AAD wrong): it do |
| MR-11 | the stuck memo ignores the head (a changed head stays paused) | m3 tests | `m3-review`: MR-11: a paused head that is replaced is pulled again (the memo is keyed on the head) |
| MR-12 | the rollback warning's maxSeenVersion is never lowered (warns every round) | m3 tests | `m3-review`: MR-12: the rollback warning is shown once (maxSeenVersion is lowered to what the server says) |
| MR-13 | the clone cursor: a new pending value for every PUT (a lost answer reported as a clone) | m3 tests | `m3-engine-units`: §4.10: the cursor's pending value is written before the PUT, under the lock, keeping enc; cur := pending after |
| MR-14 | keys.ts decisions read the identity unsettled (settlePins skipped) | m3 tests | `m3-review`: MR-14: after a key commit whose pin write failed, the next key operations still go ahead (keys.ts settles firs |
| MR-15 | commitPublished without the settle just before commitKeys | **equivalent** | `commitKeys` lays the pending copy over the pins itself, inside the vault lock (revision 2, below) |
| MR-16 | 'not in effect' said before the server's kver reached the code's (A4 discipline) | m3 tests | `m3-review`: MR-16: a round in another context while the new code's PUT is in flight says nothing about it until the server |
| MR-17 | an unconfirmed new code is no longer pending (its verdict never shown) | m3 tests | `m3-review`: every PUT /v1/keys failed before delivery: unconfirmed; once no signature of it can land, a round says not in  |
| MR-18 | repair always sends recovery_verifier (P4: forbidden when the recovery wrap is the server's) | m3 tests | `m3-repair`: the server's bundle went back across a password change: the repair asks for the password of that time, then re |
| MR-19 | adoptWithSecret signs and adopts in cfg_missing with a readable vault (RR-10) | m3 tests | `m3-review`: MR-19: cfg_missing with a readable vault (an unfinished turn-off): no adoption, nothing signed |
| MR-20 | the approver shows CC after a lost approve answer without checking (MUST 5) | m3 tests | `m3-review`: MR-20 (MUST 5): after an approve that never arrived, no confirmation code; after one whose answer was lost, th |
| MR-21 | init built over a keyring changed by another tab (the step-6 check vacuous, RR-12) | m3 tests | `m3-review`: MR-21 (RR-12): a keyring changed by another writer between step 5 and step 6, hour-aligned: keyring_changed, n |
| MR-22 | the recovery join's vaultId check vacuous (the bundle's own vaultId expected) | m3 tests | `m3-review`: MR-22: the recovery join checks the bundle against the vault id the server names |
| MR-23 | Retry-After ignored | m3 tests | `m3-faults`: 429 and 503 with Retry-After: the next try is not before it; wake() inside the backoff does not run a round |
| MR-24 | Retry-After uncapped (a server can stall sync for years) | m3 tests | `m3-engine-units`: Retry-After is honoured (never earlier than asked), and capped at a day |
| MR-25 | signatures use the uncorrected clock | m3 tests | `m3rr-rotation-fuzz`: with dirty tears (revision 19's orphan meets rotations): 6 seeded runs of 40 steps |
| MR-26 | clock_skew retried without limit | m3 tests | `m3-fake-server`: clock_skew carries server_time; api.ts retries once with the offset it learns from it (§4.14) |
| MR-27 | refNow corrected in the wrong direction | m3 tests | `m3-engine-units`: the offset at the exchange's midpoint, used within ±7 days |
| MR-28 | the worker start ignores a derived dirty (a lost kick is lost) | m3 tests | `m3-review`: MR-28: a worker start finds a commit with no kick (the page died before kicking) and schedules a round |
| MR-29 | the outbox records no head (never pushed) | m3 tests | `m3-edges`: the PUT never reached the server: the outbox stays and the next wake pushes it |
| MR-30 | the round decides from a state read before the vault load (the M3R-1 order) | m3 tests | `m3-orphan`: unlocked: a dirty slot torn; the worker round folds the orphan first, uploads, and retires it in the write tha |
| MR-31 | the rotation's 409 retried without requiring an ok merging round | m3 tests | `m3-review`: a 409 whose merging round cannot pull: not_synced, nothing sent over the unmerged head, the code not invalid;  |
| N-01 | the locked round decides from a state read before the vault load (R1b) | m3 tests | `m3-review`: R1b and M3RR-3 (revision 19's D1), locked: the recovery keeps the outbox as the orphan; the worker pushes it ( |
| N-02 | the rotation's base from a fresh status (M3R-2) | m3 tests | `m3-review`: another device writes between prepareRotation and commitRotation: the rotation merges it first; the head under |
| N-03 | the rotation's base check ignores the head (D5) | m3 tests | `m3-review`: D5 between prepare and commit: the server is at lastSynced's version again but with another head: merged first |
| N-04 | the key operations' version gate removed (M3R-3) | m3 tests | `m3-repair`: the server's bundle went back across a password change: the repair asks for the password of that time, then re |
| N-05 | the approver's version gate removed (M3R-3) | m3 tests |  |
| N-06 | the rejected identity's day measured by the attempt time again (M3R-4) | m3 tests | `m3-review`: revoked, then un-revoked by an honest rollback: two days of 30-minute wakes ask the server once a day, and the |
| N-07 | the join does not store the server offset (M3R-5) | m3 tests | `m3-review`: a device 2 days fast joins and edits at once: at most one upload per device (F5), then quiet |
| N-08 | the lost reveal never resent (M3R-6) | m3 tests | `m3-review`: the reveal never arrived: the next polls resend the identical body, and the approver gets to the SAS |
| N-09 | an undecidable pending code never decided (M3R-7) | m3 tests | `m3-review`: every PUT /v1/keys failed before delivery: unconfirmed; once no signature of it can land, a round says not in  |
| N-10 | a pending code judged 'not in effect' while its request may still land (UNDECIDED_MS ignored) | m3 tests | `m3-review`: MR-16: a round in another context while the new code's PUT is in flight says nothing about it until the server |
| N-11 | turning sync off is not idempotent (M3R-8) | m3 tests | `m3-review`: the second turnSyncOff finds the device revoked and finishes the local half |
| N-12 | a join_unfinished identity blocks a new join (M3R-9) | m3 tests | `m3rr-probes`: a complete delivered late: the new join is refused while it can land (unfinished_wait); it lands; no enrolled  |
| N-13 | pending_enrollments not stored (M3R-12) | m3 tests | `m3-review`: stored when it changes, locked too; recovery requests never count |
| N-14 | any server error code stored as it came (M3R-13) | m3 tests | `m3-rereview`: MY-25: an error code with markup in it (short) is not taken as it came: malformed_response |
| N-15 | the unlock's R4 order from the stored status only (M3R-14) | m3 tests | `m3-review`: a rotation with the same password, then an offline round over the stored status: the password still adopts VK2 |
| N-16 | a PUT's write_denied a failure, not a moved key (M3R-14) | m3 tests | `m3-review`: a PUT answered 403 write_denied while the key really moved (another device rotated): asked again, needs_passwo |
| N-17 | a 429 with Retry-After counted as a failure (M3R-15) | m3 tests | `m3-rereview`: a 503 with Retry-After counts inside a running backoff too, explicit or not (only an explicit press answered 4 |
| N-18 | a stale commit after the server accepted told as 'start again' (P-1) | m3 tests | `m3-review`: P-1: a commit refused as stale after the server accepted is committed_on_server, and the next round catches up |
| N-19 | a pruned history version fails the walk (P-2) | m3 tests | `m3-review`: P-2: a history version pruned between the list and the fetch is skipped, not a failed round |
| N-20 | init's unknown follow-up undone (P-3) | m3 tests | `m3-review`: P-3: init's vault_exists with the follow-up status unanswered: unconfirmed, the local half kept for the round |
| N-21 | a 410 after an unknown complete not settled by the status (A17) | m3 tests | `m3-review`: A17: a complete whose answer was lost is retried, gets 410, and the status as devN says enrolled |
| N-22 | the round's offset not stored before the merge (M3R-5) | m3 tests | `m3-review`: a clock that jumps two days ahead after the join: the round's new estimate is stored before applyRemote clamps |
| N-23 | a zero server_time taken as the server's clock | m3 tests | `m3-review`: a 500 whose body says server_time 0 (M4's outermost handler) moves no clock |
| N-24 | the unpinned first-upload identity loses its vault reference (M3R-10's write) | m3 tests | `m3-edges`: after the 201: the local keyring is no longer the one sent; no "in sync" pins, and nothing reverts the other t |
| N-25 | reject-all gated by the kill switch (rejecting stays possible) | m3 tests | `m3-review`: below min_client_version: no password change, no new code, no rotation, no approval, no adoption; rejecting an |
| R3-01 | the recovery hook deletes the outbox (revision 18's D1) | m3 tests | `m3-orphan`: unlocked: a dirty slot torn; the worker round folds the orphan first, uploads, and retires it in the write tha |
| R3-02 | the recovery hook overwrites an orphan already kept | m3 tests | `m2-sync-local`: recoveryHook (the store's beforeRecoveryWrite, revision 19 D1): lastSynced to null and the outbox MOVED unchan |
| R3-03 | over lost data the hook runs after the caller's function (a cloud restore deletes the outbox first) | m3 tests | `m3-orphan`: a cloud restore over a lost vault: the outbox kept as the orphan at the restore's write and folded into the re |
| R3-04 | the orphan pushed on the version alone (no head check) | m3 tests | `m3-orphan`: the orphan is not pushed when the server is at its base version with another head (D5: a rollback reused the v |
| R3-05 | the orphan dropped when its push meets a 409 | m3 tests | `m3-orphan`: the orphan's push answered 409 (the server moved between the status and the PUT): kept, folded later |
| R3-06 | the fold retires the orphan at once (not in the write that sets lastSynced) | m3 tests | `m3-orphan`: a second tear before the upload: the fold alone does not retire the orphan, so the save survives the second te |
| R3-07 | the round's lastSynced write does not retire the folded orphan | m3 tests | `m3-orphan`: unlocked: a dirty slot torn; the worker round folds the orphan first, uploads, and retires it in the write tha |
| R3-08 | an unlocked round never folds the orphan (only the locked push) | m3 tests | `m3-orphan`: unlocked: a dirty slot torn; the worker round folds the orphan first, uploads, and retires it in the write tha |
| R3-09 | the orphan_unreadable removal without a confirmed key chain (FIXa2's newer key dropped) | m3 tests | `m3-orphan`: an orphan under a key this device does not hold is not dropped while the keys are not confirmed (a password ch |
| R3-10 | no checksum-equal retirement (retirement 3) | m3 tests | `m3-orphan`: a damaged orphan record is removed; an orphan for the active generation itself (the recovery lost nothing) is  |
| R3-11 | an orphan under a previous key not opened (kept forever) | m3 tests | `m3-orphan`: R3 with an orphan under the old key: the adoption of the new key folds it (it opens through the previous list) |
| R3-12 | an orphan under a key not held removed at once (FIXa2: before the adoption) | m3 tests | `m3-orphan`: an orphan under a newer key than the recovered keyring (FIXa2): kept while it cannot be opened, folded once th |
| R3-13 | the turn-off does not fold the orphan first | m3 tests | `m3-orphan`: turning sync off with an orphan: folded into the vault that stays, then deleted with the other sync records |
| R3-13b | the turn-off deletes an orphan it could not fold (locked) | **equivalent** | `context()` refuses a locked vault before the revoke and the delete (the refusal is a second line) |
| R3-14 | a key adoption (R3, the cloud restore) does not fold the orphan | m3 tests | `m3-orphan`: an orphan under a newer key than the recovered keyring (FIXa2): kept while it cannot be opened, folded once th |
| R3-15 | M3R-9's undo deletes the orphan unfolded | m3 tests | `m3-orphan`: a join over an unfinished one (M3R-9's undo): the orphan folded before the undo and the join, so the joined va |
| R3-16 | removeSyncIdentity with an orphan and no key (its save deleted with it) | m3 tests | `m3-orphan`: a revoked device, locked, with an orphan: removing the identity is refused (locked) and the orphan kept; unloc |
| R3-17 | a retried rotation does not reconcile when the keys moved (M3RR-1) | m3 tests | `m3-rereview`: a lost rotate, then another device's key change wins: the retry says changed_elsewhere (never not_synced), the |
| R3-18 | the rotation's pending record written after the first send | m3 tests | `m3-rereview`: the pending fingerprint is written before the first rotate is sent |
| R3-19 | an unknown rotate send forgotten (a later refusal says not_synced, the pending cleared) | m3 tests | `m3-rereview`: a rotate queued in the network (outcome unknown), retried while offline: unconfirmed again (it may still land) |
| R3-20 | changed elsewhere reported without asking the keys (the rotation that landed called changed_elsewhere) | m3 tests | `m3-rereview`: a rotate queued in the network (outcome unknown), retried while offline: unconfirmed again (it may still land) |
| R3-21 | a 503 with Retry-After not counted (M3RR-2) | m3 tests | `m3-rereview`: a 503 with Retry-After counts inside a running backoff too, explicit or not (only an explicit press answered 4 |
| R3-22 | an explicit 429 inside a backoff counted again (M3R-15 lost) | m3 tests | `m3-rereview`: a 503 with Retry-After counts inside a running backoff too, explicit or not (only an explicit press answered 4 |
| R3-23 | holdingSync does not take the lock (password change, recovery key, repair, adoption) | m3 tests | `m3-rereview`: a round in another context while a password change is being sent: busy, nothing interleaved |
| R3-24 | commitRotation's pass outside sixkey-sync | m3 tests | `m3rr-probes`: a round of the worker between commitRotation's vault load and its state read: the rotation still absorbs the h |
| R3-25 | commitRecoveryCode not gated at send (M3RR-5) | m3 tests | `m3rr-probes`: a new recovery key prepared before min_client_version rose is not sent after it |
| R3-26 | the pending code's age on the local clock (M3RR-6) | m3 tests | `m3rr-probes`: a clock that jumps 11 minutes ahead: 'not in effect' is never said for a request the server still accepts |
| R3-27 | the undo while the old request may still land (no in-flight wait, M3RR-7) | m3 tests | `m3rr-probes`: a complete delivered late: the new join is refused while it can land (unfinished_wait); it lands; no enrolled  |
| R3-28 | the complete's send time not recorded (M3RR-7) | m3 tests | `m3rr-probes`: a complete delivered late: the new join is refused while it can land (unfinished_wait); it lands; no enrolled  |
| R3-29 | the init's send time not recorded (M3RR-7, first upload) | m3 tests | `m3rr-probes`: first upload: an init delivered late; the second first upload is refused while it can land; it lands and this  |
| R3-30 | a revoked pending identity blocks a new join (M3RR-8) | m3 tests | `m3rr-probes`: complete landed with its answer lost, the new device revoked from another device: a new join goes ahead |
| R3-31 | the offset written although no server time was seen (M3RR-9) | m3 tests | `m3rr-probes`: identity_missing (locked) after a worker restart: sk_sync_state.serverOffsetMs is not reset to 0 |
| R3-32 | a fresh worker's push signs with offset 0 (M3RR-9) | m3 tests | `m3-rereview`: a device two days fast: its restarted worker's locked push is signed on the corrected clock at once (no clock_ |
| R3-33 | a persistent write_denied retried as a moved key (M3RR-10) | m3 tests | `m3rr-probes`: one round sends the full envelope at most twice when nothing about the key moved |
| R3-34 | FakeServer json_content_type takes any parameter (FS-1) | m3 tests | `m3-fake-server`: revision 16's json_content_type: a JSON body without Content-Type application/json is 422 before anything else |
| R3-35 | rejectedCheckedAt written before the status query (a day spent offline) | m3 tests | `m3-rereview`: offline at the daily retry: the day is not spent, the next wake asks the server |
| R3-36 | a locked round pushes the orphan of another vault (startOver's residue) | m3 tests | `m3-orphan`: startOver over a lost vault: the orphan (of the old vault) is removed by the next round, never pushed; a locke |
| R3-37 | the join's merge on the uncorrected clock (sync off: no stored offset) | m3 tests | `m3-rereview`: a device two days slow turns sync off (its stored offset goes) and joins again: its own unsent entry keeps its |
| R3-38 | lastSynced set while an orphan the round did not fold remains (the invariant broken) | m3 tests | `m3-orphan`: an orphan the round cannot fold (a newer schema) keeps lastSynced null: no outbox is written, so a second reco |

The re-review's mutants on the revision-3 tree:

| # | The bug | Killed by | First failing test |
|---|---|---|---|
| MY-01 | push() reads the sync state before the vault load (M3R-1 on the push path) | m3 tests | `m3-rereview`: MY-01: a tear before a locked push(): the orphan is what is pushed, and the push's 200 retires it |
| MY-02 | the locked branch of loaded() reads the state before generation() (R1b) | **equivalent** | `current()` loads and recovers before `requireVk` throws `locked` (the re-review's verdict) |
| MY-03 | commitRotation loads the vault once, before the loop (the merge round's result is not what it uploads) | m3 tests | `m3-review`: another device writes between prepareRotation and commitRotation: the rotation merges it first; the head under |
| MY-04 | commitRotation reads lastSynced before the vault load (the M3R-1 order in the rotation) | m3 tests | `m3-rereview`: MY-04: a tear between prepareRotation and commitRotation: the rotation merges first, so the rotated head has t |
| MY-05 | adoptWithSecret not gated by the kill switch | m3 tests | `m3-review`: below min_client_version: no password change, no new code, no rotation, no approval, no adoption; rejecting an |
| MY-06 | the rotation's merging round may come back offline or error | m3 tests | `m3-review`: a 409 whose merging round cannot pull: not_synced, nothing sent over the unmerged head, the code not invalid;  |
| MY-07 | commitRotation's in-loop min_client_version check removed (gate at prepare only) | m3 tests | `m3-rereview`: MY-07: the kill switch raised between prepareRotation and commitRotation: update_required, no rotate sent |
| MY-08a | watchServer skips POST /v1/keys/rotate (test helper) | m3 tests | `m3-rereview`: MY-08a (the test helper): watchServer opens the rotate's envelope; a rotate that did not absorb the head is fl |
| MY-08b | watchServer skips rotate AND the rotation's base from a fresh status (N-02) | m3 tests | `m3-review`: another device writes between prepareRotation and commitRotation: the rotation merges it first; the head under |
| MY-09 | UNDECIDED_MS one tenth of the signature window (decided while a request can still land) | m3 tests | `m3-review`: every PUT /v1/keys failed before delivery: unconfirmed; once no signature of it can land, a round says not in  |
| MY-10 | M3R-9: any API error on the status undoes the pending identity (a 5xx deletes a landed join's) | m3 tests | `m3rr-probes`: complete landed with its answer lost, the new device revoked from another device: a new join goes ahead |
| MY-11 | M3R-9: the undo also for a landed join (status 200) | m3 tests | `m3-rereview`: MY-10: a 5xx on M3R-9's status (a landed join, past the window) undoes nothing: the identity the server knows  |
| MY-12 | a 429/503 not counted also loses its Retry-After (retried earlier than asked) | m3 tests | `m3-rereview`: a 503 with Retry-After counts inside a running backoff too, explicit or not (only an explicit press answered 4 |
| MY-13 | a pruned history version (404) ends the walk as unreadable | m3 tests | `m3-review`: P-2: a history version pruned between the list and the fetch is skipped, not a failed round |
| MY-14 | M3R-4 again: rejectedCheckedAt refreshed by every round that stops at the daily check | m3 tests | `m3-review`: revoked, then un-revoked by an honest rollback: two days of 30-minute wakes ask the server once a day, and the |
| MY-15 | pendingEnrollments written on every status (the steady state writes) | m3 tests | `m3-read-budget`: the steady state, unlocked: one request; the reads pinned; nothing written |
| MY-16 | a PUT's 403 write_denied taken as a revocation | m3 tests | `m3-review`: a PUT answered 403 write_denied while the key really moved (another device rotated): asked again, needs_passwo |
| MY-17 | A17: a 410 after an unknown complete taken as enrolled without asking the status | m3 tests | `m3-rereview`: MY-17: a 410 after an unknown complete, the status saying the device is unknown: unconfirmed, never enrolled |
| MY-18 | turnSyncOff finishes the local half on any refusal (a wrong password too) | m3 tests | `m3-rereview`: MY-18: turning sync off with a wrong password is refused, and nothing local is undone |
| MY-19 | the approver's approve step not gated (respond only) | m3 tests | `m3-rereview`: MY-19: the kill switch raised between the approver's start and its SAS step: no approval is sent |
| MY-20 | commitRotation without the 'key changed meanwhile' check | **masked** | the server-keys-moved reconciliation runs first and meets every reachable case |
| MY-21 | an unlocked round drops the outbox before it knows the outcome (P10: the worker has nothing to push) | m3 tests | `m3-faults`: a timeout (the answer never comes): offline; the outbox and the local edit are kept; the next round settles it |
| MY-22 | the 10-minute rule ignores whether the server still holds the code's base bundle | **near-equivalent** | decides earlier only once the server left the base bundle, when no request with that `if_kver` can land (the re-review's verdict) |
| MY-23 | M3R-5: the join's offset stored before complete (an unknown complete keeps the uncorrected clock: no) -> offset never stored by firstUpload | m3 tests | `m3-rereview`: MY-23: the first upload stores the server offset (M3R-5): local edits from then on stamp with the corrected cl |
| MY-24 | P-1: a stale commit after the server accepted reported as success (pending cleared, 'in effect' said, local keyring old) | m3 tests | `m3-review`: P-1: a commit refused as stale after the server accepted is committed_on_server, and the next round catches up |
| MY-25 | M3R-13: the error code check allows any short text | m3 tests | `m3-rereview`: MY-25: an error code with markup in it (short) is not taken as it came: malformed_response |

Revision 2: **99 plausible bugs, 98 killed by tests, 1 equivalent** (the runner, outside the patch: a copy of the tree,
the exact replacement, `tsc --noEmit`, the M3 test files with `--bail 1`, then the whole suite for a survivor). Every
mutant typechecks; none counts as "killed by tsc". The run was on the revision-15 tree; rebasing onto revision 17 changed
main's contract files and added the FakeServer's Content-Type rule and its test, not one line the mutants replace.
- M3-01 to M3-43: the first revision's (§ below; re-anchored where this revision changed the line, M3-27).
- MR-01 to MR-31: the review's (`scratchpad/m3r-scripts/mutr.py`), run here since its table was left "TODO". On the
  patch the review read, sixteen of them survived (MR-02, -04, -06, -09, -11, -12, -14, -15, -16, -19, -20, -21, -22,
  -28, -30, -31). MR-30 and MR-31 are rewritten against the fixed code (the M3R-1 order on every attempt; the
  rotation's 409 retried without requiring an "ok" merge).
- N-01 to N-25: one or two per fix of this revision (N-24 and N-25 after the last two changes, on the final tree).

The survivors needed tests, now in `m3-review` ("M3R-11: the gaps behind the review's surviving mutants" and the
finding blocks). Three took a second look:
- MR-09 (F5's raw comparison): the review found it masked. The clamp shifts all of an entry's stamps by one delta, so a
  forged entry with only its content stamp ahead still differs from the merge in its placement stamp, and the round
  uploads anyway. With both stamps forged ahead, the merge equals the clamped remote exactly, and only the comparison
  with the raw remote uploads: the F5 end-to-end test now does that and kills it.
- MR-12 (the rollback warning) and MR-28 (start's derived dirty): the first versions of their tests passed under the
  mutants (notices are one per kind and time, so the repeated warnings coincided; the commit wrote an outbox, which
  schedules a round by itself). The tests now advance the clock between rounds and remove the outbox.
- MR-15 is equivalent (below).
Under load (four mutants in parallel), the whole-suite fallback once "killed" MR-09, MR-12 and MR-28 by timing out the
8 MiB D3 test (180 s); each was rerun alone and judged on the M3 tests, as the table says.

The first revision's notes on these 43: M3-13, M3-31, M3-38 and M3-42/43 each needed the test they lacked (a stale
capability raced, the write throttle, every write of a blocked round, the guard on the adoption and rejoin merges);
"dirty by seq" is the stand-in M3-11 (lastSynced has no seq).

---

## 8. Not done (M3)

- The wiring (M5): the runtime's port `afterCommit`, the worker's timers and alarms, `webLock("sixkey-sync")`, the fetch
  transport and the message bridge, the badge, the periodic alarm.
- The repair with a **newly generated** recovery key (N24: "typed or newly generated"): `repairKeys` takes a typed one;
  M6 needs a prepare/commit pair like `prepareRecoveryCode`'s for a new one (the new recovery wrap, then P4's verifier).
- The repair when the server is back on an older **VK** (§4.2 "以本机为准修复云端" as a rotate that keeps this device's
  VK, N24): the engine reports `server_older_key`; the same-VK repair (`keys_behind`) is built.
- Fork / "split this identity" (§4.10, M6) and "rejoin from the cloud" into a new vault id (§3.5, M6): the engine
  reports `forked` and `different_vault`.
- The HOTP 2-second pull before a code (§3 item 14; M5/M6).
- startOver deleting the orphan itself (§3 item 27: the next round removes it; startOver is VaultService, the popup's
  bundle). The PITR restore fence (M3RR-13: M4/M8).
- Running the engine tests against the real M4 server in CI (§1.3: done by hand for revisions 2 and 3; M5/M6 make it a
  suite).
- Account deletion and fork are in the API client only (no flow, M6).
- From the review, deferred: M3R-10 (M2: a `setReference()` for an unpinned identity's vkId and vaultId, and
  `identity.update` refusing pin fields; the engine keeps its one `update` write until then);
  moving `totpOffset`/`clockNotice` to a popup-eligible module (M3R-13: the popup module list, M5); displaying
  `lastErrorCode` as untrusted text (M6); P-4 (the recovery quota, kept as is); the FakeServer's rate limits and
  retention (D7, D9: faults stand in).

---

## 9. What a reviewer should attack first

1. The round's write path: `engine.ts loaded()` and `attempt` from `needPull/dirty` to the CAS, with `state.ts
   casLastSynced` and the outbox push in `lockedRound` (+ `pushed`): is there any interleaving (a recovery, a popup
   commit, a second context, a rollback) in which a state that was never merged with the server's head is uploaded, or
   lastSynced claims a sync that did not happen? Revision 2's M3R-1 fix rests on "a recovery's hook runs inside the
   vault lock before the pointer moves"; check that every load path that can recover (`current`, `generation`,
   `vaultStatus`) is followed, not preceded, by the state read the decision uses.
2. `keys.ts commitRotation`: the base is lastSynced only while the server's (version, head) equal it; is there a path
   where a rotation still replaces a head its vault has not merged (a round "ok" that did not set lastSynced, a commit
   between the state read and the send)?
3. `keys.ts`: server first, then `published()` + `commitKeys`; `sendKeyOp`'s reconciliation and resend (the same text
   only while the server holds the bundle it was built on); `adoptWithSecret`'s "new key" test (by the local keyring's
   vkId; M1's `sameVk` means "the pinned key", not "the local one"); `repairKeys`' choice of auth and verifiers (§3 item 17).
4. `enroll.ts firstUpload` and `requireOff`: the order of steps 4–7 against RR-12, what an unknown init answer leaves,
   and the M3R-9 undo (a pending identity the server does not know).
5. The approval path's empty remote (§3 item 6).
6. The FakeServer as an oracle: rate limits and retention are still not modelled (§3 item 16).
7. The kill switch's exemptions (§3 items 20, 21): a design-owner question, implemented one way here.
8. Revision 3, the orphan (§0.1): every path that can make one (the store's recovery writes, the hook's placement over
   lost data), every path that removes one (three retirements, damaged, another vault, unreadable after a confirmed
   key chain, turn-off and removeSyncIdentity after a fold), and whether any interleaving retires it before the save is
   on the server or in a generation that lastSynced names (a fold, then a tear; a push answered 200 for another
   record; a CAS that retires an orphan the round did not fold).
9. Revision 3, `commitRotation`'s reconciliation (M3RR-1): every way a retry can learn the keys moved (status, `GET
   /v1/keys`), and whether any outcome other than `unconfirmed` can be reported while a rotate of the handle may still
   land.
10. Revision 4 (revision 20): every place that writes `sk_sync_outbox: null` or removes a list entry, against §4.7's
    "deleted only in three cases" (the unlocked "nothing to send" round, the CAS, the flows' `clearingItems`) and the
    three retirements; the list's two appenders (the hook, `demoteOutbox`); whether any interleaving sets lastSynced
    while an unparked entry is unfolded (the CAS, `pushed()`); the parked states (when an entry becomes and stops being
    parked; `SyncLocal.turnOff` keeping marked entries only, §0.2 item 9: withdrawn in revision 5, item 11 below); the
    merge-only outbox never reaching a PUT.
11. Revision 5 (the delta): `SyncLocal.turnOff({folded})` and each of its five callers (does any flow report an entry
    folded that is not in the vault it leaves; can any entry be appended between the fold and the turn-off and still be
    named in `folded`?); `foldForFlow`'s load before the read; `parseOrphanItem`'s newer-format branch (its synthetic
    parked mark, `checksum`/`envelope` taken from the record or its JSON); `discardParked`'s critical section.
12. Revision 6 (the delta): `foldForJoin` and its three call sites (can a join still be prepared on a vault without an
    unparked entry?); `keptAtTurnOff` with `activeHolds` (can the live outbox be deleted while the active slot does not
    hold it: a slot torn after the read, inside the lock?); the required checksums of "Advanced".

---

## 10. The M5 hand-off (the review's §8, with the re-review's corrections)

1. **Preconditions:** this revision: M3R-1, M3R-2, M3R-3, M3R-12 (revision 2) and M3RR-1, M3RR-2, M3RR-3 (revision 3:
   revision 19's orphan) fixed; the FakeServer aligned with M4 (revision 18) and exact on Content-Type (FS-1).
2. **The outbox:** in `platform/runtime.ts`, `createSyncPort`'s port gains `afterCommit: createOutboxWriter(local)`; M2's
   exact popup module list in `m2-source-rules` gains `core/sync/local/outbox.ts` deliberately; re-measure check-dist
   (revision 4: 55,978 B, +791 B over the unwired build, 54.7 KB of 60 KB; the merge-only branch included); verify P10 (an
   edit in "lock every time" mode, the popup closed at once, is pushed by the worker; with a torn slot, the orphan entry
   is: `m3-rereview` "lock every time"; revision 20: a stale outbox is demoted, never dropped, and while lastSynced is
   null every commit writes the merge-only outbox).
3. **One `SyncEngine` per syncing context** (the service worker, the settings page; never the popup). `EngineDeps`:
   `origin` = M4's `SIXKEY_API_ORIGIN` (the signed host); `clientVersion` = `chrome.runtime.getManifest().version`;
   `vaultLock` = `webLock("sixkey-vault")`; `syncLock` = `webLock("sixkey-sync", { ifAvailable: true })`, held by the
   context running the round **and by every key operation** (`commitRotation` per pass, the others for their whole
   write: M3RR-4); the worker's transport serving a page never takes it (§4.9 D10); `now` = `Date.now`; `sleep` = a
   `setTimeout` promise; `rng`/`random` from `crypto.getRandomValues`; `hlcDevice` = `sk_device`; `diag` = the
   diagnostics sink (codes only).
4. **The transport (`platform/api.ts`):** fetch to the one API origin only, bundled into `sw.js` only; pages through
   `chrome.runtime.sendMessage({type: "sk-api"})` with the `sender.id` check (the page's engine signs, the worker only
   sends); **a fetch timeout of at most 60 s and no retry inside the transport** (a retry is the engine's: it re-signs,
   and M3R-7/M3RR-6's ten minutes assume no request outlives its signature); every unknown outcome rejects with
   `NetworkError`; the request's `Content-Type` exactly `application/json` as `api.ts` sets it, never rewritten (M4
   refuses anything but that and `; charset=utf-8`); response header names lower-cased; the body raw text.
5. **Timers:** `Wake.via` "timeout" → `setTimeout`, "alarm" → `chrome.alarms` (`sk-sync-kick`, the retry alarm), then
   `engine.wake(name)`; `engine.start()` at every worker start (it schedules a round for an outbox, an orphan or a derived
   dirty); `sk-sync-periodic` (30 min) with `periodicPhaseMinutes(random)`; `sk-sync-soon` → `engine.kick()`; HOTP →
   `kick({ immediate: true })` plus the UI's 2 s `Promise.race(round)` (§4.12).
6. **The popup** renders local data first and asks the worker for a round when `lastOkAt` is over 30 s old; it never builds
   an engine. Before the "use the corrected time" switch ships: M3RR-9 is fixed here (a stopped round or push never
   resets the stored offset); move `totpOffset`/`clockNotice` out of `core/sync/engine/` into a popup-eligible module
   first (M3R-13: the popup module list).
7. **The badge:** `chrome.action.setBadgeText` from `view().state.pendingEnrollments` (written on change by every round,
   locked too); **cleared when sync is off and when the status is `update_required` or `rejected_by_server`** (no round
   refreshes the count then).
8. **Configuration:** M4's `min_client_version` default `0.1.0` against the manifest's `0.0.1`: **bump the manifest in the
   change that ships sync** (or set `SIXKEY_MIN_CLIENT_VERSION`), else every round and every non-exempt write is
   `update_required`. The account session: `api.signIn(email, code)` (or `sessionFromToken`) gives `{ token, sub }` from
   M4's JWT; keep it in the page's memory only.
9. **Manifests and check-dist (§7):** the three manifests with the API origin as the only `host_permissions` entry and in
   CSP `connect-src`; check-dist enforces fetch only in `sw.js`, no engine module in the popup, the budget, the
   permission allow-list; rewrite `network.spec`.
10. **e2e against M4:** first through a Node fetch transport on the M3 tests that need only `transport()` and `session()`
    (§1.3; the review's harness is a start), then Playwright with 2–3 persistent contexts (§8.6). Include: the torn
    active slot followed by a worker round with no popup open (M3R-1); a rotation racing another device's write (M3R-2);
    **a lost rotation answer retried with the same handle** (M3RR-1); **a sustained 503** (M3RR-2: the gaps grow);
    **an outbox plus a torn slot, in "lock every time"** (M3RR-3: the orphan pushed by the worker, or folded at the next
    unlock); **the kill switch raised between prepare and commit** (rotation and new code: M3RR-5); **a worker restart in
    `identity_missing`** (M3RR-9: the stored offset kept).
11. **The enrolment screens:** MUST 7 and 8; after an unknown `complete` and a 410, the status as devN (A17, done in
    `commitJoin`); the reveal resend is in `ApprovalJoin.poll` (M3R-6).
12. **Visible events:** "keys adopted back" (RR-6) from the `keys_adopted` notice and security record; `orphan_unreadable`
    (an acknowledged save could not be recovered: its key is gone).
13. **Shipping gate:** "turn sync on" ships only with M6's sync settings (⊗).
14. **For M6:** `resumeFirstUpload` on a first upload's `join_unfinished`. From a join's `join_unfinished`, a new join:
    - goes ahead once the old identity is unknown to the server and its last init/complete was sent over 10 minutes
      ago, or at once when it was revoked (M3RR-8);
    - is refused `unfinished_wait` with the time left before that (M3RR-7: show "try again in N minutes"; the old
      request may still land, and then the round finishes that join instead);
    - `already_on` when the server knows the identity (the round finishes it), `status_failed` on a 5xx;
    - use a fresh account session for the retry (M4's `one_per_session` 409 within one session).
    A `review_needed` answer in page memory only, including the one `turnSyncOff`/`removeSyncIdentity` raise as
    MergeBlocked for an orphan's fold; `lastErrorCode` shown as untrusted text; the KeyOpError codes (`offline`,
    `unconfirmed`, `not_synced`, `changed_elsewhere`, `busy`, `update_required`, `committed_on_server`) as §1.2 defines
    them; the repair with a newly generated code and the `server_older_key` repair (§8); fork; "rejoin from the cloud".
    In `needs_password` (the server rotated to a key this device does not hold yet) the revoke screen runs
    `adoptWithSecret` first with the same typed password: the pre-send check cannot verify a bundle under an unknown VK
    (the review's §3.2, by design).
15. **For M6, revision 20's orphan list (§6 O12):**
    - the parked notice: `parkedSummary(view().orphans)` with sync on, `readParkedOrphans(kv, lock)` on the security page
      with sync off; the reasons and their ways out ("schema": update Sixkey; "key": unlock with the newer password /
      adopt; "too_large": make room under the entry limit); "Advanced": `discardParkedOrphans({kv, vaultLock}, {count,
      checksums})` with the `count` and `checksums` of the summary the user confirmed, both required (revision 6; a list
      changed meanwhile, or a call without the checksums, throws `bad_state`: show the notice again);
    - `vault_lost` (KeyOpError / EnrollError): point to the cloud restore (§4.13) or a backup restore;
    - with sync off, every settings-page unlock calls `foldParkedLocally` (a guard block throws MergeBlocked: the same
      review screen, then call again with the answer). Revision 5: a turn-off keeps every entry it did not fold, so the
      list can hold unparked entries with sync off too (the first upload's undo folds nothing); this fold takes them.
      With sync on it returns `"sync_on"` and touches nothing (the round folds);
    - a guard block on an undo's fold (M3R-9, the revoked pending identity): the join's own review screen; call the join
      again with `answer` (`joinWithRecoveryCode`, `ApprovalJoin.start`, `firstUpload`), or answer through
      `round({answer})`.
16. **For M6 and the design owner: the known residuals (§B).** Above all §B item 1: entries kept by a turn-off are
    removed without a word after a join to ANOTHER vault when they could not be folded first (parked entries; unparked
    ones over a lost local vault). It needs a visible notice and a design decision (warn before such a join; re-encrypt
    the kept entries under the joined key beside `sk_prejoin`; or at least raise `orphan_unreadable`). Revision 6 closed
    the locked case: both joins refuse `locked` while a locked context leaves an unparked entry unfolded. The other
    items (§B 3–6) are fixes with a design choice each, written there.
17. **For M6, the joins and the turn-off (revision 6):**
    - `joinWithRecoveryCode`, `ApprovalJoin.start` and `ApprovalJoin.submitConfirmationCode` can throw
      `EnrollError("locked")` for the orphan fold: show "unlock first". After a refusal at the code nothing was prepared
      or written: call `cancel()`, have the user unlock, and start the approval again (the new start replaces the
      unpinned pending identity at once); the approving device approves the new request;
    - `submitConfirmationCode` can also throw MergeBlocked (a guard block on that fold): the same review screen, then
      start again with `answer`;
    - after turning sync off, `sk_sync_orphan` may hold the outbox of the last save (moved there when the active slot
      could not be shown to hold it); the settings page's next unlock folds it (`foldParkedLocally`), nothing to show.
18. **M8:** the PITR restore fence (M3RR-13, revision 19 §5.2): until it exists, a late write after an honest rollback can
    replace another head for a round (`m3rr-replay` pins the case; the data comes back from the devices).
