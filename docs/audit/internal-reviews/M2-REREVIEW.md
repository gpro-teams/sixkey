# M2 re-review: the fix delta (M2R-1 … M2R-20 as merged)

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the reviewer line, repository paths updated to the current layout and absolute local
> paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and
> were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the
> test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-17. Reviewer: a Claude Opus re-review session of the fixes made after `docs/audit/internal-reviews/M2-REVIEW.md`. Review only:
> nothing in the main tree was changed except this file, and nothing was committed.
>
> **Scope**: the merged M2 in the main tree, read against the before-M2 snapshot (`scratchpad/phase0x/snap/before-M2/`)
> and the first-round reviewed copy (`scratchpad/m2-review/`). Spec: SYNC-DESIGN rev. 13 (§0.0i items 1–18, §0.0l,
> §0.0m, §2.5, §3.1, §3.5, §3.9, §4.1), M2-NOTES, M2-REVIEW, GM2-REVIEW, A4-REVIEW, M1-REVIEW.
>
> **Scratch** (all under `scratchpad/`):
> - `m2-rereview/`: main as merged (rsync, `node_modules` linked). My probes and matrices run here:
>   - `extension/test/regression/m2rr-probes.test.ts`: 9 probes, all passing (each pins today's behaviour; a passing
>     probe demonstrates its finding);
>   - `extension/test/fault/m2rr-crash-ext.test.ts`: the extended matrices (rows in `m2rr-crash-ext.json`);
>   - `extension/test/unit/m2rr-settle-reads.test.ts`: what `settlePins()` and `status()` read.
> - `m2rr-mut/mutrr.py`, `m2rr-mut/results.json`: my 25 mutants (tsc, then the whole vitest suite).
> - `m2rr-fix/`: prototypes of the fixes for RR-1, RR-2, RR-3 and RR-7, with the full suite and my probes run on them.
>
> Line numbers are the main tree's.

## Verdict

**M3 AFTER FIXES.**

The fixes are real and mostly sound. M2R-1's mechanism (pendingPins in the clearing write, the digest round trip, the
settle before decisions) holds at every crash point I could reach outside a lying disk, including 610 new rows for a
Published commit, which the implementer's matrices do not have, and a matrix over the settle itself. M2R-2, M2R-3,
M2R-5–M2R-11 are fixed as described, with the nuances below.

One Medium finding must be closed before M3 writes its first `commitKeys` caller, because it is in the contract M3
builds on: **RR-1**. M2-NOTES §4.2 item 4 says "a capability can be committed more than once … the in-lock checks make
a replay harmless". They do not. A stale or replayed same-VK capability writes an older keyring over this device's own
newer key change, and the next round then calls the server's (newer) bundle `keys_behind`, whose only button
re-publishes the old state. That is PROBE-1's harm (M2R-1, High) through a different door.

**Counts**: Critical 0, High 0, Medium 1, Low 11.

**Top 3**
1. **RR-1 (Medium)**: `commitKeys` binds a capability to nothing M1 saw. An R2 adoption evaluated before this device's
   own new recovery code, committed after it (an SW round racing the settings page, or any retry), reverts the code; a
   replayed `Published` reverts a later password change.
2. **RR-2 (Low)**: the capability carries the caller's own, unfrozen bundle object. Mutating it after M1's verdict makes
   `commitKeys` write a keyring nobody evaluated, including one no secret opens.
3. **RR-3 (Low)**: "turn sync off" takes no vault lock. A key commit or a join in flight in another tab outlives it:
   stale `pendingPins` survive into the next enrolment (its new identity inherits an old `maxSeenKver`), or a join
   leaves `identity_missing`, and the next unlock restores the identity the user just removed (the M2R-6 class again).

## Verification (in `m2-rereview/`)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run` (merged main, unchanged) | 78 files, **1277 passed, 1 skipped** (matches the implementer) |
| my probes, matrices, read counts | 3 files, 17 tests, all passing (the probes demonstrate the findings) |
| `npm run build` + `check-dist` | OK. Popup **53.8 KB gz** (static 49.9 + zh_CN 3.9) against 60 KB. Full catalogs en 9.1, zh_CN 10.3 KB. |
| M2 code in the bundles | `pendingPins`, `sixkey-identity`, `putIfAbsent`, `MergeBlocked`, `prejoin_exists` appear in **no** built file (nothing builds SyncLocal/SyncFlows until M5). What M2 puts in the shared service chunk the popup loads is the light part only (`noSync`'s throw, the security kinds, the sync state's read and clear, the records' cleanup). |
| popup module graph (`m2-source-rules`) | exact set holds; `scripts/catalog-keys.mjs` follows `import()` and fails computed specifiers; my dynamic-import bypass (Q25) is killed |
| read gates | `read-budget.test.ts` byte-identical to before-M2 and green (sync off 4 / 7 / 10); `read-budget-sync` green (sync on: the same keys) |
| untouched baselines | `enable-crash`, `fault/store`, `keychange-marker`, `gm2-crash-matrix`, `gm2-fixes`, `open-view-diff`, `security-log-crash`, `read-budget`, `source-rules`, `perf.spec`: byte-identical to before-M2 |
| e2e | not re-run: the caller's 99/99 run was on this exact tree. With sync off, the new page-path code (`noSync` in the six operations the Security panel and Reset tab call) is one read and a no-op. |

## Findings

### RR-1 (Medium): a stale or replayed capability writes an older same-VK keyring over a newer one

**Where**: `core/service/sync-flows.ts:239-283` (`commitKeys`), in particular `:262-268`; `core/sync/crypto/capability.ts:23`
(`KeysToCommit` has no reference to the state M1 judged); the claim in M2-NOTES §4.2 item 4 ("a replay harmless").

**What the in-lock checks cover**: the pins' vault and reachability (F7), previous-list continuity, and the lock-out
guard re-checked against the stored keyring for `same_password_wrap` and against the identity for `adopted_back`.
Nothing compares the stored keyring with the local keyring M1 evaluated, or the bundle's kver with the pins. For the same
VK, an older keyring keeps the same previous list, so continuity passes; `built_here` and `opened` have no stored-state
check at all; `same_password_wrap` passes whenever the newer local change touched only the recovery wrap.

**Failing sequence** (probe `RR-1`, first case; the second case is the `Published` replay)
1. Steady state at B5 (kver 5). Another device makes a new recovery code: the server holds B6.
2. This device's SW pulls B6 and evaluates it: an R2 `adopt` (`same_password_wrap`), capability C6.
3. Meanwhile the settings page makes this device's own new code on top of B6: pre-send on B6, `PUT` B7 accepted,
   `commitKeys(published B7)` gets the vault lock first and commits.
4. The SW's `commitKeys(C6)` then runs. Every check passes: same VK, same previous list, and B7's password wrap is B6's.
5. The local keyring is B6. The code the user just saved (B7's) no longer opens it. The pins say `maxSeenKver` 7,
   `adopted` B6.
6. Next round: the server's B7 is `keys_behind` (kver 7 ≤ 7, content ≠ local and ≠ adopted). The only button, "repair",
   re-publishes B6's wraps with a higher kver, and the new code is then invalid everywhere.

The same happens on any retry of an older capability after a newer commit (probe, second case: a `Published` B6
replayed after a `Published` password change B7 leaves the new password unable to open this device).

M3 cannot close this from outside without holding one lock across evaluate → commit in every context that commits
keys (the `sixkey-sync` lock is per round, and the design does not say the page's key operations take it).

**Fix** (prototyped in `m2rr-fix/`, below): the capability carries the local keyring M1 judged (`base`: `i.local` in
`evaluateSameVkBundle` and `unlockWithSync`; for `published()`, the `local` of the `preSendCheck` that issued the
`VerifiedServerBundle`, kept in a module `WeakMap`). Inside the transact, before anything else:
`canonicalJson(cur?.keyring ?? null)` must equal `canonicalJson(base)` or `canonicalJson(bundle.keyring)` (the landed
retry), else `bad_state("stale")` and nothing is written; M3 re-evaluates. Correct M2-NOTES §4.2 item 4.

**Blocks M3**: yes.

### RR-2 (Low): the capability's bundle is the caller's mutable object

**Where**: `capability.ts:28-30` (`issue`: `Object.freeze({...keys})` is shallow; `keys.bundle` is the very object
the caller passed); `bundle-eval.ts:101`, `:211`; `presend.ts:147`.

**Failing sequence** (probe `RR-2`): `unlockWithSync` returns an `adopt` (`opened`) for B6. The caller then changes
`B6.keyring.wraps[*].wrapped` (a builder that reuses the parsed object, a retry that re-seals in place). `commitKeys`
writes the changed keyring: neither the typed password, the old one, nor the recovery code opens it. `opened` and
`built_here` re-check nothing about the wraps in the lock, so the lock-out guard (§0.0i item 16) is bypassed.

**Fix**: in `issue`, store a deep-frozen `structuredClone` of the bundle (and of `base`, RR-1). One line; prototyped.

**Blocks M3**: no (fix it with RR-1).

### RR-3 (Low): `turnOff` takes no vault lock, so commits and joins in flight outlive it

**Where**: `core/sync/local/sync-local.ts:140-142`; `pins.ts:44-50` (`begin` re-creates `sk_sync_state`), `:72`
(`identity.vkId === null` applies anything); `sync-flows.ts:343-347` (the join writes `sk_sync_cfg` in its transact).

**Failing sequences**
- (probe `RR-3`) A `commitKeys` (B6, kver 6) is in its transact when "turn sync off" runs in another tab. turnOff removes
  `sk_sync_*` and the identity; then the commit's `begin` writes `sk_sync_state = {pendingPins: B6}` and the commit
  lands (no identity to pin, so the copy stays). Months later the account is deleted and sync is turned on again as the
  first device of a new account (§3.1). Step 5 puts a fresh identity (`vkId: null`); the next `status()` settles the
  stale copy onto it (`maxSeenKver` 6, `adopted` B6). Step 7's `setPins(kver 1)` cannot lower it. A new recovery code
  made by another device of the new account (kver 2) is then `keys_behind` here, and "repair" re-publishes this
  device's keyring over it. The same stale overlay makes a later `commitJoin` refuse "not the joining device's" when
  the stale vault id differs.
- (probe `RR-3b`) A `commitJoin` writes `sk_prejoin`, then turnOff runs to completion, then the join writes
  `sk_sync_cfg` and commits: the profile is `identity_missing`, and the next unlock's `restoreSyncIdentity` brings the
  identity back: sync is on again after the user turned it off.

**Fix**: `turnOff` under the vault lock (`vaultLock(() => identity.remove(() => local.remove(SYNC_OFF_KEYS)))`: vault
→ identity, the allowed order; `turnOff` is never called inside the vault lock). Optionally bind `pendingPins` to the
`deviceId` it was written for and apply it only to that identity. Prototyped (the vault lock): both probes flip.

**Blocks M3**: no.

### RR-4 (Low): "moving forward" is `pending.maxSeenKver ≥ identity.maxSeenKver`, so an equal-kver stale copy moves the pins back

**Where**: `pins.ts:72`.

**Failing sequence** (probe `RR-4`): commit A (kver 6) lands and pins; its `pendingPins` clear is in storage.local's
unflushed tail. Commit B lands with the same `maxSeenKver` (an R3 "仍然采用" of an older bundle, an adopt-back or a
cloud restore keep it unchanged) and is pinned in IndexedDB. storage.local then loses its tail back to just after A's
commit (GM2-5, several writes). `settlePins()` sees A naming the active keyring, 6 ≥ 6, and applies it: `adopted` goes
from B back to A. The GM2-5 adopt-back of B is lost; B on the server is now `keys_behind`, and "repair" publishes A over
the user's choice. `maxSeenKver` is a max-of-seen value, not a per-commit order, so it cannot tell which of two
equal-kver commits is later.

A related edge: `published()` sets `maxSeenKver = sent.kver` (`presend.ts:146-147`). When `publishKver` is capped by
`KVER_MAX_JUMP` (an identity whose `maxSeenKver` was set far ahead, F-01), the pending copy carries less than the
identity, and a lost IndexedDB write is dropped instead of applied (M2R-1 again, in that edge).

**Fix**: put the commit's store sequence (`gen.seq`) in `Pins` (pending and stored) and break kver ties with it; or
record the residual in §0.0i item 17. Pass `max(identity.maxSeenKver, sent.kver)` from M3 (or compute it in
`commitKeys` from the view) for the published edge.

**Blocks M3**: no.

### RR-5 (Low): `sk_prejoin`'s own-retry exception is keyed on (cloud key, local vault id) only

**Where**: `core/sync/local/record-writers.ts:77-81`.

**Failing sequence** (probe `RR-5`): vault V0 (with an account in its trash) joins cloud A in added mode: `sk_prejoin`
= V0 under VK_A. Sync off. The local vault becomes unreadable and the user restores an older backup of V0 (same vault
id). Joining cloud A again (added mode) passes `check`: the record is under VK_A and names V0, exactly like "this
attempt's own record". The first join's record, with its trash, is replaced. That is the promise M2R-5 restored
("never replaced").

**Fix**: allow the exception only for this attempt's record: open it with the cloud key and compare the plaintext with
`p.prejoin.plain` (one decrypt), or store an attempt nonce beside it.

**Blocks M3**: no (M6).

### RR-6 (Low): `adopted_back` trusts IndexedDB alone; an identity rolled back on its own turns a replay into an adoption

**Where**: `bundle-eval.ts:88`, `:101`; `sync-flows.ts:268`; M2-NOTES §4.2 items 3 and 4 (the declined `adopted.from`).

**Failing sequence** (probe `RR-6`): steady at B5; this device commits its own B6 (new code) and B7 (new password).
IndexedDB alone goes back to its B5 state (a vendor's IndexedDB sync from a stale copy, an old copy of the identity
DB: the reverse of the §2.5 case). The server replays B5 (malicious, or a PITR coinciding). `evaluateSameVkBundle`
returns `adopt` (`adopted_back`, kver 5 ≤ 5) and `commitKeys` writes B5: the new code and the new password stop
working. Without the adopted digest the same input is `keys_behind`. M2's decision that "adopted_back counts as built
here" is consistent with the GM2-5 rule; the exposure is that rule's.

**Fix**: the reviewer's optional hardening, which is not redundant after all: `adopted.from` = the digest of the keyring
the commit replaced, and adopt back only when the local keyring is exactly that one (the true GM2-5 state). Design
owner's call; it changes M1's `AdoptedRecord`.

**Blocks M3**: no.

### RR-7 (Low): on a lying IndexedDB, the pending copy is cleared without the pins having landed

**Where**: `pins.ts:56-60` (`commit`), `:94` (`settle`): `clear(p)` follows `setPins` with no read-back.

**What the matrix shows** (`m2rr-crash-ext.json`, "lie rows"): "pins behind after the settle" occurs in exactly one write
per key commit (the IndexedDB pin write: write 8 of the R2, R3 and Published commits, 9 of the cloud restore, 10 of the
join), 10 rows in all; the settle matrix shows the same at its own write 1. It is in `LIE_RESIDUAL`, but unlike the
other A4R-10 residuals its consequence is M2R-1's (a silent revert by adopt-back). M2R-14's precedent (read back the
write whose loss costs the most) applies.

**Fix**: read the identity back (one IndexedDB get) and clear only if it carries the pending pins; prototyped: the
class disappears from the lie rows and the suite stays green.

**Blocks M3**: no.

### RR-8 (Low): test gaps behind my surviving mutants

See the mutant table below. Each survivor is a plausible bug the suite cannot see:
- **Q02** (the forward rule compares against `maxSeenVersion`): the "backward, dropped" cases in `m2-sync-local` and
  `m2-review` use a pending copy whose `adopted` equals the identity's, so applying it changes nothing. The only case
  where the rule matters (an older commit's copy under a newer `adopted`, RR-4's shape) is untested.
- **Q09** (`published()` skips the lock-out check for rotations): no test sends a rotation whose keyring the secret
  does not open.
- **Q10** (changePassword's `noSync` outside its transact): the in-transact race test covers `rotateKey` and
  `newRecoveryCode` only.
- **Q11** (prepareReset checks `noSync` after the code): PROBE-4 uses the right code, so a wrong code recorded as
  `recovery_failed` with sync on goes unseen (the "nothing recorded" promise of item 18).
- **Q19** (commitReset checks `noSync` before its "landed" test): no test retries a reset that landed before sync was
  turned on.
- **Q14** (commitJoin checks only the identity's device, not its vault): the "pinned to another vault" half is
  untested (the existing test uses another device's identity).
- **Q17** (a damaged `sk_prejoin` may be replaced): untested; `check()`'s doc says a damaged record is never replaced.
- **Q21** (`writeInLock` keeps another device's `state`): a new device's copy over an old one would inherit "enrolled".
- **Q36** (`pendingPins.maxSeenKver` = `bundle.kver`): differs only for a commit at or below `maxSeenKver` (adopt-back,
  "仍然采用"); no test loses the IndexedDB write of such a commit.
- **Q13** (the restore's `still()` ignores the copy's deviceId): defence in depth, untested.
- **Q18** (the recovery hook drops `pendingPins`): equivalent today (a pending copy only exists right after a write that
  set `lastSynced` to null, and the hook writes nothing then), live once M3 sets `lastSynced` between a commit and its
  settle; `m2-sync-local`'s "every other member kept" does not include `pendingPins`.

**Fix**: one test each. **Blocks M3**: no.

### RR-9 (Low, analysis only): with no readable local keyring, the settle does not lay the pending copy over the identity

**Where**: `pins.ts:68` (`if (!active) return { identity, pending, action: "keep" }`: the raw identity).

**Sequence** (analysis; no probe): a commit lands and its IndexedDB pins are lost (pendingPins kept); then the slots,
the mirror and the keyring copy become unreadable while `sk_sync_state` survives (a partial storage.local loss). At the
cloud-restore decision `settlePins()` returns the stale identity (`adopted` = the previous bundle, the old
`maxSeenKver`). If the server then serves that previous bundle (replay, PITR), `unlockWithSync(local: null)` finds it
"the same content" (adopted digest) and returns `adopt` without the R3 confirmation, and the cloud restore commits the
old keyring (`checkPins` does see the pending copy, so another VK is still refused). With the overlay it would be
`keys_behind` / `confirm_older`.

**Fix**: every pending copy names a bundle the server held (a Published only after acceptance, an adoption of the
server's bundle), so overlay `maxSeenKver` (always safe) and `adopted` in the "keep" case too.

**Blocks M3**: no.

### RR-10 (Low, analysis only): `noSync` keys on `sk_sync_cfg` alone, not on the identity

**Where**: `service.ts:645-647`; `state.ts:52-55` (`context()`).

**Sequence** (analysis): `cfg_missing` with a readable vault (a `turnOff` that died between its two halves, a vendor
or a crash that dropped `sk_sync_cfg` alone). The identity still holds its pins and can sign; `newRecoveryCode` (or any
of the six) proceeds. If M3 runs a round there, the server's bundle is the identity's `adopted` and is adopted back over
the new code: PROBE-4's harm.

**Fix**: in M3, never run rounds or sign in `cfg_missing` with a readable vault before re-creating `sk_sync_cfg` (or
finishing the turn-off); alternatively let `noSync` also refuse when the identity exists. Hand-off item (below).

**Blocks M3**: no.

### RR-11 (Low): the Phase 0 pages show "unexpected error" for `sync_on`

**Where**: `src/ui/errors.ts` (no entry for `sync_on` or `prejoin_exists`); the Security panel and the Reset tab call
the six operations.

**Sequence**: once a build can turn sync on (M5), the user clicks "Change password" (or "New recovery code", "Rotate",
"Reset") in the settings page: `ServiceError("sync_on")` is shown as the generic error, with no route to §3.6–§3.8.

**Fix**: M6's text, or a one-line entry now ("Sync is on: change this from the Sync section"). M5 must not ship turning
sync on without it.

**Blocks M3**: no.

### RR-12 (Low, analysis only): the first upload (§3.1 rev. 13) pins "in sync" without checking that the local keyring is still the sent one

**Where**: SYNC-DESIGN §0.0i item 16 (the first-upload bullet) and §3.1 step 7 (M3 code; nothing in M2).

**Sequence** (analysis): steps 4 to 5 run before `sk_sync_cfg` exists, so a Phase 0 key operation in another tab
(`changePassword`) is not refused there. If M3 builds `init`'s bundle from the keyring it read before step 5, the
server stores the old keyring; after 201 M3 writes `adopted` = that bundle "as in sync". The next round finds the
server's bundle equal to `adopted` and different from the local keyring: adopted back at once, and the password change
made in the other tab is silently reverted. If M3 instead re-reads the keyring at step 6 (after `sk_sync_cfg` is
written), the changed keyring's untruncated `createdAt` makes the server answer 422 (N16): a visible failure, no harm.

**Verdict on rev. 13**: sound, provided the design text says so: read `init`'s keyring after step 5, and before writing
the "in sync" pins (after 201, or after the `GET /v1/keys` recovery) check that the local keyring is still the sent one,
else treat it as an ordinary round. The truncation is a service method with `noSync` (§0.0i item 16 already says so).

**Blocks M3**: no (a design-text line and an M3 check).

## Notes (measurements and confirmations, not findings)

- **Read cost** (`m2rr-settle-reads`): `settlePins()` in the steady state reads `sk_sync_state` once and the identity
  once; `status()` reads `sk_sync_cfg`, `sk_sync_state` and the identity; with a pending copy the settle reads
  `sk_sync_state` three times, the pointer, the slot, the identity twice, and writes twice. The "4 / 7 / 10 unchanged"
  claim is true for M2 (no settle on those paths). M3 must keep the settle off the popup's open and unlock (unlock is at
  7 of a gate of 8, the degraded unlock at 10 of 10), which it must anyway: the popup does not load `pins.ts`.
- **`MergeBlocked.seen`** (`sync-flows.ts:136-141`) is an unsalted SHA-256 of the remote entry, secret included. M2
  stores none of it; if M3 persists an answer, keep it in memory or use an HMAC under a VK subkey.
- **The equivalence claims hold.** **R20**: a live entry always has a secret, so `addAccountsFrom(…, "alive")` adds it
  or skips it for a live cloud duplicate with the same `addedModeKey`; ② cannot fail today (it is defence in depth for
  YubiKey entries without a secret). **N61**: `putIfAbsent` re-checks under the identity lock and the identity's
  removal takes that lock after the storage.local removal; every interleaving ends "off".
- **Splitting `begin` into two writes** (the clear, then `pendingPins`), which the brief asked about, is equivalent for
  crashes: both land inside the callback, before the marker and the slot, so a death between them leaves no landed
  commit, and a lying disk drops one write either way. The rules that matter are "unconditional" (Q04, killed) and
  "before the commit" (Q05, killed).

## The fixes, attacked

### (1) M2R-1: pendingPins and the settle

**Sound**
- `begin` (`pins.ts:44-50`) writes `pendingPins` in the same `kv.set` as the lastSynced/outbox clear, always, inside
  the transact callback, after every check (`sync-flows.ts:275`, `:347`), so before the marker and the slot.
- "Names the active keyring" is the digest round trip (`adoptedRecord({keyring: active, auth: pending.adopted.auth})`),
  so a copy of a commit that never landed (a crash before the pointer, the FIXa2 rollback, a recovery to an older
  generation) is dropped; it cannot move the pin ahead of the local keyring. A copy that names the active keyring is,
  by construction, the keyring that is there, so applying it never creates the GM2-5 lock-out state.
- The vault lock serializes settle with every commit; vault → identity is the only nesting (`setPins` inside the vault
  lock; `putIfAbsent`'s `still()` reads storage.local without a lock). No inversion, no re-entry.
- It works while locked (plaintext keyring, no VK), which `unlockWithSync` needs.
- An SW restart mid-settle (my settle matrix: 27 rows, each of its writes before / after / lie, with a second dying
  settle) leaves nothing behind outside a lying write (RR-7).
- Three contexts (SW `applyRemote`, the page's R3 commit with IndexedDB refusing writes, a third context's settle and
  status): all land; the next settle catches the pins up.

**Not sound**: RR-4 (equal kver), RR-7 (lying IndexedDB), RR-3 (a turned-off profile keeps a copy), RR-9 (no
overlay without a keyring). Test gaps: Q02, Q36 (RR-8).

### (2) M2R-4: commitKeys and the capabilities

**Sound**
- The brand: a module `WeakMap`; a structured clone, a spread copy, a prototype child and a `Proxy` of an issued
  `Adoption` are all refused (probe "sound: the capability brand"); clones cannot cross contexts (M1-19). Only
  `bundle-eval.ts` and `presend.ts` call `issue` (source rule; my Q38, a capability keyed by its bundle object, is
  killed).
- Continuity in the lock: an older VK is refused (PROBE-7); the same VK keeps every real previous entry; another VK must
  really unwrap the stored VK.
- The pins' vault and reachability apply to every commit, including an unsettled pending copy (Q15 is killed).
- `same_password_wrap` is re-checked against the stored keyring; `adopted_back` against the settled pins;
  `published()` opens the sent keyring with the secret (one KDF), checks kver, shape and continuity against the
  verified server bundle.
- "adopted_back counts as built here": sound against the server (it can only replay the exact bundle this device last
  committed, whose wraps this device's own guard accepted) and against a buggy M3. Against someone who can write the
  identity: anyone who can write the extension's IndexedDB can write its storage.local keyring too, so the guard was
  never a boundary there. The residual is IndexedDB rolled back on its own (RR-6).
- `maxSeenKver` is never lowered (`setPins` takes the max; the overlay too).
- First upload (§3.1 rev. 13): no issuer is needed, because no keyring is written after 201; see RR-12 for the check
  the design text should require.

**Not sound**: RR-1 (stale or replayed capabilities), RR-2 (mutable bundle). Q08 (continuity skipped for
`adopted_back`) survives, but it is equivalent today: `adopted_back` is same-VK only, and M1 ran the same
`previousCovers` on the same inputs at evaluation; it differs only for a stale capability, which RR-1's fix refuses
first.

### (3) M2R-3: the Phase 0 key operations with sync on

**Sound**
- `noSync()` is inside the transact of the five that write (`enableMasterPassword` `service.ts:662`, `rotateKey`
  `:685`, `changePassword` `:784`, `commitReset` `:845`, `newRecoveryCode` `:875`), before any secret is used there;
  `prepareReset` (`:807`, which writes nothing) and `newRecoveryCode` (`:866`) check first; `commitReset` checks after
  its "landed" test.
- Every context's service has the port (`platform/runtime.ts:28-34`), so the settings page's Reset tab and Security
  panel, the popup and the SW are all covered. `sk_sync_cfg` is written only inside the vault lock (the join's
  transact, `SyncCfgCopy.write`), so "sync turned on between check and write" is serialized.
- No other service path changes an existing vault's keyring: `makeVault` (create, `restoreBackup`, `startOver`) only
  from empty or lost (item 11 by design); `importBackup` and `purgeForever` keep the keyring; there is no one-call reset
  any more (A4R-5).

**Gaps**: Q10, Q11, Q19 (tests, RR-8); RR-10 (`cfg_missing`); RR-11 (the UI text).

### (4) M2R-2: the GM2-5 pre-send

**Sound**: `publishesBundle(op) || !allowedWhileKeysBehind(op)` refuses exactly the five publishing operations
(including `repair`) and `respond` / `approve`; `revoke`, `reject`, `reject_all`, `rename`, `fork`, `clear_history` and
`delete_account` go ahead as in `keys_behind`, proving against the server's MAC-verified bundle. None of those seven
publishes or hands out a bundle (`fork` sends a new device key and `name_ct` only, §4.10). In that state a typed old
password reads `password_changed_elsewhere`, which is the right next step.

### (5) The lows

- **M2R-5** `prejoin_exists`: fixed, read back after the write; the own-retry exception is too wide (RR-5).
- **M2R-6** restore vs turnOff: fixed for the restore (`putIfAbsent` under the identity lock); the same class comes
  back through a join (RR-3b).
- **M2R-7** the mirrored state: sound. A crash between M3's `identity.update` and `cfg.setState` leaves the copy one
  transition behind, which only matters after IndexedDB is lost; M3's signed status query resolves it, so it should
  confirm every restored identity, not only a "pending" one.
- **M2R-8** the popup rule: sound (module graph, `import()` followed; Q25 killed).
- **M2R-9** the landed join pins inside the lock: sound.
- **M2R-10** no marker from applyRemote: sound.
- **M2R-11** answers bound to SHA-256 of each remote entry: sound; nothing of the content is stored by M2 (Notes).
  "Keep mine" keeps a trashed entry trashed (`deleted: !isAlive(o)` with a fresh `dhlc`).
- **commitJoin's new refusal**: sound; it reads the settled overlay, so RR-3's stale copy can make it refuse.

## Crash matrices

- The implementer's three matrix files ran green inside the full suite (about 1300 rows).
- **Added** (`m2rr-crash-ext.test.ts`):

  | Matrix | Rows | Outside a lying disk |
  |---|---|---|
  | `Published` own new recovery code: single faults and lie, with and without a restart | 86 | 0 violations |
  | the same, double fault (restart dies at its write 1–6) | 174 | 0 |
  | `Published` rotation (§3.8 P4): single and lie | 116 | 0 |
  | the same, double fault | 234 | 0 |
  | every key commit and the join, lie only | 164 | (residual classes only; RR-7 counted) |
  | the settle itself dying at each write, then a second dying settle | 27 | 0 (3 lie rows: RR-7) |
  | three contexts, one IndexedDB refusing writes | 1 | sound |

- The "D8 window" (`rawBehind`) is reached in both Published ops (18 single-fault rows each), so the settle invariant is
  not vacuous there either.

## Tests

### My mutants (`m2rr-mut/mutrr.py`; tsc, then the whole vitest suite with `--bail 1`)

**25 mutants: 11 killed (all by vitest, none by tsc alone), 14 survived: 10 real test gaps, 4 equivalent or
equivalent today.** None repeats one of the implementer's 128 exactly; each is a subtler variant of a fix's rule.

| Id | Mutation | Result |
|---|---|---|
| Q01 | settle's "names the active keyring" checks vkId and vault only (the digest ignored) | killed (m2-crash-matrix) |
| Q02 | the forward rule compares with `identity.maxSeenVersion` | **survived** (gap, RR-8) |
| Q04 | `begin` writes `pendingPins` only when there is something to clear | killed (m2-service) |
| Q05 | `begin` moved into `afterCommit` | killed (m2-crash-matrix) |
| Q06 | `commit` clears the pending copy also when there is no identity | killed (m2-sync-local) |
| Q07 | `commit` clears the pending copy before `setPins` | killed (m2-crash-matrix) |
| Q08 | `commitKeys` skips continuity for `adopted_back` | survived (equivalent today: same-VK only, M1 ran the same check; differs only for a stale capability, RR-1) |
| Q09 | `published()` skips the lock-out check for rotations | **survived** (gap) |
| Q10 | changePassword's `noSync` outside its transact | **survived** (gap) |
| Q11 | prepareReset's `noSync` after the code check | **survived** (gap) |
| Q12 | `PUBLISHES` misses `recovery_reset` | killed (sync-crypto-m2) |
| Q13 | the restore's `still()` ignores the deviceId | **survived** (gap, defence in depth) |
| Q14 | commitJoin's identity check ignores the vault | **survived** (gap) |
| Q15 | `checkPins` ignores an unsettled pending copy | killed (m2-service) |
| Q16 | the forward rule ignores the vault | killed (m2-sync-local) |
| Q17 | a damaged `sk_prejoin` is replaceable | **survived** (gap) |
| Q18 | the recovery hook's clear drops `pendingPins` | survived (equivalent today; live with M3) |
| Q19 | commitReset's `noSync` before its "landed" test | **survived** (gap) |
| Q20 | a copy without `state` restores as "enrolled" | survived (equivalent today: every writer sets `state`) |
| Q21 | `writeInLock` keeps another device's `state` | **survived** (gap) |
| Q22 | enableMasterPassword's `noSync` outside its transact | survived (equivalent: with sync on the keyring is never a device-key one, so it fails `already_protected` before writing) |
| Q23 | the guard's `seen` digests the local entry, not the remote | killed (m2-service) |
| Q25 | the popup lazily imports `pins.ts` (`import()`) | killed (m2-source-rules) |
| Q36 | `pendingPins.maxSeenKver` = `bundle.kver` | **survived** (gap) |
| Q38 | the capability keyed by its bundle object (a hand-built `{bundle}` passes) | killed (m2-crash-double-keys only: the brand tests never reuse an issued bundle in a forgery) |

### The implementer's mutation claims

- 128 mutants, 126 killed, 2 equivalent: I did not re-run the 128 (the first review re-ran the earlier 45; the full
  suite is green). The two equivalence claims hold (Notes). N09 and N47 have their tests.

### Existing tests changed relative to before-M2

All mechanical or stronger:
- security-log `v: 1 → 2` and "newer" `2 → 3` (`security-log.test.ts` 5 lines, `security-notice.test.ts` 3,
  `service.test.ts` 1, `security-log.spec.ts` 1, `security-helpers.ts` a type);
- `sync-crypto-hygiene`: the "nothing imports it yet" rule became an allowlist whose members must each really import;
- `sync-crypto-adoption`: `adoptedBack: false` in the old loop, a new exhaustive `adoptedBack` loop, `reachesLocal`
  (384 → 768), the model's unlock order;
- the other M1 tests and `sync-vectors.ts`: `adoptedDigest: null`, or T-02's model digest.

No assertion was weakened. `enable-crash` and `fault/store` are byte-identical.

## Corrections to the M3 hand-off checklist (M2-NOTES §7)

1. **Item 1 (pins)**: "at unlock" cannot mean the popup's unlock (the popup does not load `pins.ts`, and its unlock has
   one read of headroom). Settle in the SW or page before each decision; budget 1 storage.local and 1 IndexedDB read in
   the steady state (Notes).
2. **Item 2 (capabilities)**: strike "a capability can be committed more than once … harmless" (M2-NOTES §4.2 item 4).
   Until RR-1 is fixed: drop every capability once anything has committed since it was issued, and evaluate and commit
   under one lock in every context that commits keys. Never mutate an object passed to M1 after its verdict (RR-2).
3. **Item 6 (`sk_sync_state`)**: give the writers one helper (read-modify-write under the vault lock, keeping unknown
   members) and a source rule that nothing else writes the key. `turnOff` is the one M2 writer outside the vault lock
   (RR-3).
4. **Item 8 (`identity_missing`)**: confirm every restored identity's state with the signed status query, not only a
   "pending" one (the copy can be one transition behind).
5. **New: §3.1, the first upload**: the truncation through a service method with `noSync`; build `init`'s bundle from
   the keyring read after `sk_sync_cfg` is written (step 5); before the "in sync" pins (after 201, or the
   `GET /v1/keys` recovery) check that the local keyring is still the sent one, else treat it as an ordinary round
   (RR-12).
6. **New: `cfg_missing`**: never run rounds or sign there with a readable vault before re-creating `sk_sync_cfg` (RR-10).
7. **Item 10 (pre-send)**: in the GM2-5 state a revoke typed with the old password returns `password_changed_elsewhere`;
   M6 asks for the newer password (the device's own).
8. **Item 13 (error texts)**: M5 must not ship turning sync on before M6's `sync_on` text (RR-11).
9. **Item 14 (the join)**: settle first; a stale pending copy (RR-3) makes `commitJoin` refuse; replace the identity per
   §3.5.

## Appendix: probes (`m2-rereview/extension/test/regression/m2rr-probes.test.ts`)

| Probe | Finding | Shows |
|---|---|---|
| RR-1 (2 cases) | RR-1 | an R2 adoption committed after this device's own new code reverts it, then `keys_behind`; a `Published` replay reverts a later password change |
| RR-2 | RR-2 | a bundle mutated after the verdict is written; no secret opens it |
| RR-3 | RR-3 | turnOff racing a commit leaves `pendingPins`; a new enrolment's identity inherits `maxSeenKver` 6; a kver-2 change elsewhere is `keys_behind` |
| RR-3b | RR-3 | a join racing turnOff ends `identity_missing`; the restore turns sync back on |
| RR-4 | RR-4 | an equal-kver stale copy moves `adopted` back after a multi-write tail loss |
| RR-5 | RR-5 | a second join to the same cloud key replaces the first join's `sk_prejoin` |
| RR-6 | RR-6 | IndexedDB rolled back alone + a replay: adopted back over B7 (was `keys_behind`) |
| brand | sound | clones, copies, prototype children and proxies are refused |

## Appendix: the fix prototypes (`m2rr-fix/`)

Four changes, about 25 lines (RR-4, RR-5, RR-6 not prototyped):
- **RR-1**: `KeysToCommit.base` (the local keyring M1 judged; `published()` takes it from a `WeakMap` that
  `preSendCheck` fills beside its `VerifiedServerBundle`), and in `commitKeys`' transact, first:
  `now = canonicalJson(cur?.keyring ?? null)`; refuse `bad_state("stale")` unless `now` is the base's or the bundle's.
- **RR-2**: `issue()` stores a deep-frozen `structuredClone` of the bundle and the base.
- **RR-3**: `turnOff` = `vaultLock(() => identity.remove(() => local.remove(SYNC_OFF_KEYS)))`.
- **RR-7**: `pins.commit` and the settle read the identity back and clear the pending copy only if it carries the pins.

Results (`m2rr-fix/`, full suite plus my files):
- **1283 passed, 11 failed, 1 skipped.** The 11:
  - 6 of my probes flip as intended: RR-1 (both), RR-2, RR-3 and RR-3b (these two now wait for the vault lock, which the
    probes' own ordering cannot satisfy: the race is gone);
  - 5 existing tests whose expectation changes, not their intent: PROBE-7 and three `m2-service` refusal tests are
    still refused with nothing written, but as `stale` before `discontinuous` / `different_vault` (put the stale check
    after `checkPins` to keep their reasons); two `sync-crypto-m2` shape tests see the new `base` member and the copy.
- The extended matrices on the prototype: Published single, double and rotation rows still 0 violations outside the
  lying disk; "pins behind after the settle" is gone from every lie row and from the settle matrix.
