# G-M2 combined review: A1 + A2 + FIXb + FIXa2, merged state

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the reviewer line, repository paths updated to the current layout and absolute local
> paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and
> were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the
> test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Reviewer: a Claude Opus review session (PHASE0X-PLAN §3.4, "before G-M2, one more combined review of A1
> and A2 after both are merged"). Review only: nothing in the main tree was changed except this file, and nothing was
> committed.
>
> **Scope** (merged main tree): `extension/src/core/service/service.ts`, `extension/src/core/storage/{store,format,kv}.ts`,
> `extension/src/platform/{runtime,session}.ts` (plus `locks.ts`, `chrome-kv.ts`, `idb-kv.ts` that they wire), the popup
> and options code that calls them (`popup/{App,load}.tsx`, `popup/screens/Locked.tsx`, `options/{App,Security,FirstRun}.tsx`,
> `background/sw.ts`), and the hand-off to M2 (SYNC-DESIGN §0.0f / §0.0h "M2 requirements", §2.5, §3.0, §3.6–§3.9, §4.6–§4.7).
> FIXa2 (`store.ts:192-200`) is new since docs/audit/internal-reviews/A2-REVIEW.md and was reviewed here from scratch.
>
> **Scratch** (session-scoped; the probe and matrix sources are reproduced in Appendices B and C so everything stays
> reproducible): `scratchpad/`
> - `gm2-review/` — rsync of the repo (no node_modules/dist/test-results; `contract/`, `api/` included; node_modules symlinked)
> - `gm2-review/extension/test/regression/gm2-review.test.ts` — 19 probes (Appendix B)
> - `gm2-review/extension/test/regression/gm2-crash-matrix.test.ts` — crash matrix, 8 operations (Appendix C); rows in `gm2-review/matrix.json`
> - `gm2-mut-run.py`, `gm2-mut/<id>/result.json`, `gm2-mut-all.log` — mutation runner and results
> - `gm2-fixroot/extension/` — the proposed fixes for GM2-1(a), GM2-2, GM2-3 applied (diff in Appendix D)
>
> Line numbers are those of the merged main tree.

## Verdict

**M2 AFTER FIXES.**

The FIXa2 / FIXb design holds where it was aimed. I walked every key-changing operation through every write, both
before and after the write lands, with and without a browser restart: 356 crash points, Appendix A. At every point:
- every account is still there;
- some credential the user holds opens the vault;
- after `selfCheck`, the pointer slot, `sk_keyring` and the mirror generation carry one keyring;
- old material on disk always has a cleanup due;
- no device material survives the next cleanup.

FIXa2 cannot roll back data the user saw saved after a key change: the first save after the change always overwrites
the old-keyring slot (question 1(c), probes and mutant X2).

What is not sound:

- **The new-code window.** The remaining way to end up "committed, with the new recovery code never shown and the saved
  one dead" is wider than the window FIXa2 closed. It covers every write after the commit (17 of the 20 writes of a
  rotation, including the whole cleanup), plus a `startSession` that throws after the commit and reports a failure.
  This is GM2-1.
- **Same-VK keyring changes** (password change, reset, new code) are invisible to the marker protocol. P-5 remains, and
  the documented M2 hook `transact({keyChange:true})` silently does nothing for a same-VK adoption (GM2-3).
- **FIXa2 rolls back silently.** It also leaves the rejected keyring in the other slot (GM2-2).
- **SYNC-DESIGN §0.0h requirement 4 contradicts the code.** Copies under a key outside `keyring.previous` are never
  offered to the re-encrypt callback, and the marker is cleared anyway (GM2-4).
- **The IndexedDB identity record.** Written after the transact, it can get ahead of a keyring that FIXa2 rolled back.
  The spec's rules then leave the device stuck in `bad_mac` or `keys_behind`, with no working exit (GM2-5).

The fixes for GM2-1(a), GM2-2 (heal part) and GM2-3 are small. They were applied together in scratch and pass the full
suite; only the two tests that pin the old behaviour flip (Appendix D).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 (GM2-1) |
| Medium | 5 (GM2-2, GM2-3, GM2-4, GM2-5, GM2-6) |
| Low | 7 (GM2-7 … GM2-13) |
| Info | 3 (GM2-14 … GM2-16) |

**Top 3**
1. **GM2-1 (High).** A key change commits, then the process dies or `startSession` throws before the page shows the
   code. The user's saved recovery code is then dead, and the new one was never seen. The crash matrix finds this at 35
   of 41 crash points of `rotateKey` and of `enableMasterPassword`, 7 of `resetPasswordWithRecovery` (which runs in the
   popup, which closes on focus loss) and 5 of `newRecoveryCode`. The password still opens the vault in every case, so
   the loss comes later, when the password is forgotten. Nothing tells the user.
2. **GM2-3 (Medium, blocks M2).** The marker and the cleanup judge "old material" by vkId only.
   - After `changePassword`, `resetPasswordWithRecovery` or `newRecoveryCode`, the other slot keeps the old wrap. The
     old password or code unwraps the VK there, and that VK decrypts the current data (P-5).
   - The hook M2 is told to use for same-VK adoption writes the marker, and then `finishKeyChange` reports `done` and
     removes the marker with the old wrap still in place.
3. **GM2-4 and GM2-5 (Medium, both block M2: spec decisions).** Two findings share this slot because both are
   decisions SYNC-DESIGN must make before M2's adoption code.
   - GM2-4: `finishKeyChange` keeps every snapshot under a key that is neither current nor previous, never calls the
     callback for it, and removes the marker. §0.0h req. 4 assumes the callback re-encrypts §3.5's old local VK, and
     §3.8 P4 / §3.9 R3 name `rewriteForKeyChange`, which drops such copies instead.
   - GM2-5: a power loss can drop the local commit while the IndexedDB pin write survives. FIXa2 then keeps VK1 with
     the pin at VK2, and the D8 repair rule only handles the opposite case. The device ends up stuck in `bad_mac` or
     `keys_behind`, and the repair path cannot work because it needs VK2's `K_write`.

## Verification (scratch copy of the merged tree)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` | 54 files, **933 passed, 1 skipped**: matches the integrator's numbers |
| `npm run build && npm run check` | check-dist OK, **popup 54.4 KB gz** (static 45.6 + zh_CN 8.9), budget 60 |
| `npm run build:e2e && npx playwright test` | **72 passed** (7.0 min) |
| Review probes (`gm2-review.test.ts`) | 19 pass on the merged tree, so every REPRO reproduces and every SOUND holds |
| Crash matrix (`gm2-crash-matrix.test.ts`) | 8 operations, 356 crash points, all hard invariants hold (Appendix A) |
| Mutation testing | 20 mutants on FIXa2 / FIXb / commit order / marker protocol (§Q5) |
| Fix experiment (`gm2-fixroot`) | GM2-1(a) + GM2-2 heal + GM2-3 together, full vitest suite: see Appendix D |

## Findings

### GM2-1 (High): a key change that commits but whose result never reaches the user — the commit-then-show window

**Where**
- `service.ts:415-434` (`enableMasterPassword`) and `:437-454` (`rotateKey`): the order is `transact` (commit),
  `startSession`, `scrubQuietly` (the whole cleanup), and only then the code is returned.
- `:504-523` (`resetPasswordWithRecovery`, called from the popup's `Locked.tsx:39`): `transact`, then `startSession`.
- `:526-536` (`newRecoveryCode`).
- `:491-501` (`changePassword`).
- The page shows the code only after the call returns (`Security.tsx:51,76,82`; `Locked.tsx:39-41`).

**Failing sequences** (Appendix A; probes "Q1(b) REPRO")

1. **Process death after the commit.** The process dies anywhere between the pointer write and the return: the tab or
   popup closes, the browser or extension restarts, the browser crashes.
   - **rotateKey**: the commit is write 3 of 20. The 35 distinct crash points from "write 3 lands" to "write 20" all end
     in the same state. The vault is under VK2, the recovery code the user saved no longer opens it, and the new one
     was never shown.
   - **enableMasterPassword**: the same 35 points. The vault is password-protected, with a recovery code nobody saw.
   - **resetPasswordWithRecovery**: 7 points. The code the user just typed is dead and the new one was never shown.
   - **newRecoveryCode**: 5 points.

   FIXa2 cannot help: the pointer names the new slot.
2. **`startSession` throws after the commit.** It can fail on a transient `chrome.storage.session` write or on the
   `sk_settings` read inside `RoutedSession`. Then:
   - `rotateKey`, `enableMasterPassword` and `resetPasswordWithRecovery` reject;
   - the page shows a generic error, and `Security.tsx`'s `run()` reloads and shows the protected state;
   - no code was ever returned.

   In the popup, retrying the reset with the code just used gives `wrong_secret` (probe).

In every case the password the user typed, or the unchanged password, still opens the vault (the "creds" column in
Appendix A). The damage is deferred: the user believes their saved code works, and it does not.

**Why it matters more than the window FIXa2 closed**
- FIXa2 removed one write's worth of exposure: the slot landed, the pointer did not.
- This window is every write after the commit, and it needs no storage fault at all. Closing the page at the wrong
  moment is enough.
- For `enableMasterPassword` and `rotateKey` it includes re-encrypting every snapshot (up to 17) before the code is
  shown.

**Fix**
- (a) **Before M2.** Steps after a committed key change must not throw. Use
  `startSession(...).catch((e) => this.diag(...))` in the four methods. The user may then have to unlock, which is
  safe. SYNC-DESIGN I2 already describes exactly that ("crash between commit and session = locked, enter the
  password"). This is in the fix experiment.
- (b) **Before A1/A2 ship.** Return the code before the cleanup: either `void this.scrubQuietly(...)`, or let the page
  call a `finishKeyChanges()` after it has shown the code. The marker already guarantees the cleanup at the next open
  or unlock, so nothing is lost if the page dies first. This shrinks the window to the three guarded redundancy writes.
- (c) **The robust fix.** Show the code before the commit, the way A1's `prepareKeys` does:
  - prepare `rekey` / `setRecovery` in memory and show the code;
  - the user confirms;
  - then commit with an opaque one-shot handle and the `LANDED` idempotency that `makeVault` already has.
  - The UI copy must say "keep your old code until this says *done*".

  SYNC-DESIGN §3.7 and §3.8 P2 already require this order for sync-enabled operations. The local-only paths should
  match before Phase 1 ships.
- (d) **Move the popup reset to a tab.** The reset shows its code in the popup (GM2-13), which closes on focus loss, the
  reason A1 moved first-run to a tab.

**Blocks M2**
- (a) yes. M2's adoption sequence (transact, then `startSession`, then the pin write) inherits the same failure: a
  throw reports "failed" for a committed keyring, and the pin is never written.
- (b) yes, together with GM2-3. GM2-3 adds a cleanup to the three same-VK operations, and if that cleanup is awaited
  before the code is returned, the never-shown window grows: in Appendix D, reset goes from 7 to 15 crash points and
  newRecoveryCode from 5 to 13.
- (c) and (d): no for M2, yes for release.

### GM2-2 (Medium): FIXa2 rolls back silently, and leaves the rejected keyring in the other slot

**Where**: `store.ts:199-206`. When FIXa2 picks the pointer slot, no event is pushed: the only event is `slot_fallback`,
and only for a broken pointer slot. `restoreRedundancy` gets the rejected newer slot as `otherGen`, and
`store.ts:253-258` leaves a valid other slot alone unless it holds a stale device key.

**Failing sequences**

1. **Silent rollback** (probe "FIXa2 rolls a change back silently").
   - The user resets the password with R1, sets P2, sees R2 and saves it.
   - A power loss drops only the pointer write. The next browser start rolls the reset back.
   - No `StorageEvent` is recorded. P2 now fails with "wrong password" and R2 with "wrong recovery code", with nothing
     to explain why.
   - For a reset, the credentials that "work again" are the password the user had forgotten and a recovery code the UI
     had just told them is dead. A user who has already replaced R1 with R2 in their password manager is locked out.
   - This is the owner-accepted cost of FIXa2. The code comment (`store.ts:196-197`, "the old password and recovery
     code open the vault again") understates it for reset.
2. **The rejected keyring stays** (probe "newRecoveryCode dies at the commit").
   - Same-VK changes write no marker. After the process dies at the commit:
     - `selfCheck` keeps the old keyring (correct);
     - the unseen-code keyring stays in the other slot with a higher seq, and no open, unlock or cleanup removes it.
   - A later, unrelated fault on the pointer slot makes `recover()` commit it, and the saved R1 stops working.
   - In the matrix this case is 2 crash points per same-VK operation: the slot write landed (1a) or the process died
     just before the pointer write (2b). For `enableMasterPassword` it is 2a and 3b, where a device vault never runs
     the cleanup on open, so its marker also stays forever (harmless).
   - The other "other slot differs" points in Appendix A, completed runs included, are the superseded OLD keyring
     after a commit. That is P-5, covered by GM2-3.

**Fix**
- **(a) Overwrite the rejected slot in the same step.** Pass `null` as `otherGen` when FIXa2 fired, so "heal other slot"
  overwrites it. Both slots then agree with the rollback the owner chose. This is in the fix experiment: the leftover
  count drops to 0 for every operation (Appendix D).
- **(b) Record a new event kind**, e.g. `keychange_rolled_back`, whenever FIXa2 fires. The popup shows it: "A change to
  your password or recovery code did not finish and was undone. Your previous password and recovery code open
  Sixkey; a code shown to you just before this does not." This needs one `StorageEventKind` and two i18n strings.
- **Optional, the owner's call.** Instead of (a), keep the rejected slot until the next successful unlock. If the user
  types a secret that opens only the rejected keyring, roll forward: the user has proved they hold it. That removes
  the reset-lockout cost entirely, at the price of a second keyring lookup on a failed unlock.

**Blocks M2**: no. (a) is recommended before M2, so that M2 never adopts or publishes a keyring that FIXa2 rejected.

### GM2-3 (Medium): same-VK keyring changes are outside the marker protocol (P-5); `transact({keyChange:true})` is a no-op for them

**Where**
- `store.ts:428-430`: a marker is written only when the vkId changes, a device key goes away, or lost data is
  overwritten.
- `store.ts:598`: `staleIn`'s `old()` compares the vkId and the device key, not the keyring.

**Failing sequences** (probes "P-5 / M2 REPRO")
- **After `changePassword`.** The other slot's keyring carries the old password wrap. `unlockWithPassword(otherSlot.keyring,
  OLD)` yields the VK, and that VK decrypts the current envelope, which has the same VK. The same holds for the old
  recovery code after `newRecoveryCode` and `resetPasswordWithRecovery`.
- **Until the next save, which can be days.** The keyring copy and the mirror are updated by the transact; nothing
  touches the other slot.
- **What M2 is told to do does not fix it.** For a same-VK adoption of a remote password change, M2 is told to use
  `transact({keyChange:true})`. The marker is written, then `finishKeyChange(vk)` finds nothing stale, returns
  `done: true`, removes the marker, and writes `sk_store_v`. The old password still unwraps the VK from the other slot.

**Security impact.** Someone holding the old password (the usual reason to change it, and the reason §3.6 step 1 exists)
plus a profile copy taken before the next save opens everything current. The keyring in LevelDB residue is the same
material (SECURITY.md "Limits"), but a live record survives compaction and needs no forensic tooling, so this is
strictly worse than residue. Same-VK password changes never protect against someone who already had the VK; §3.6.1
step 5 says so, and that is unchanged.

**Fix** (in the fix experiment; the full suite passes except the two tests that pin the old rule, Appendix D)
- `store.ts:428-430`: a marker whenever `canonicalJson(prev.keyring) !== canonicalJson(gen.keyring)`. This subsumes the
  vkId and device-key conditions.
- `store.ts:598`: `old = (k) => canonicalJson(k) !== canonicalJson(gen.keyring)`.
- `changePassword`, `resetPasswordWithRecovery` and `newRecoveryCode` run the cleanup after the commit
  (`scrubQuietly(vk, vk)`). Since the VK is unchanged, this costs a few writes and no snapshot re-encryption. It must
  run **after** the code is returned (GM2-1(b)). The fix experiment awaited it before returning, and the never-shown
  window grew from 7 to 15 crash points for reset and from 5 to 13 for newRecoveryCode (Appendix D).
- Update two tests:
  - `keychange-marker.test.ts` "a transact that takes the device key away while keeping the key id writes it too"
    expects no marker on the step that adds a password wrap;
  - `a2-review.test.ts` "the cost (owner's decision) …" no longer rolls back once the cleanup has finished, which is
    strictly better.

**Must it be fixed before M2 same-key adoption?** Yes. Otherwise the hook M2 is told to rely on does nothing for that
case. The rest of P-5 (the Phase 0 local change) is cheap enough to fix in the same patch.

**Blocks M2**: yes.

### GM2-4 (Medium): copies under a key outside `keyring.previous` are never offered to the re-encrypt callback (contradicts SYNC-DESIGN §0.0h req. 4)

**Where**
- `store.ts:570` (`finishKeyChange` → `rewriteInner(..., unknownKey: "keep")`) and `:688`: a snapshot under a vkId
  that is neither current nor in `previous` is kept, without calling `reencrypt`.
- `:578-579`: the marker is then removed.
- `:639`: `rewriteForKeyChange` uses `unknownKey: "drop"`, and it neither writes `sk_store_v` nor touches the marker.

**Failing sequence** (probe "M2 REPRO: finishKeyChange never offers …")
1. Adopt, through `transact({keyChange:true})`, a keyring for a new VK that does not list the local VK. That is
   SYNC-DESIGN §3.5 (join a vault: a different vaultId), §3.3 (enrol with the recovery code) and cloud restore.
2. Call `finishKeyChange(vk2, callback)`.
3. The callback is invoked **0 times** for the old-VK snapshots, they are kept (`kept > 0`), `done === true`, and the
   marker is gone.
4. Nothing ever looks at those snapshots again. They age out under the limits: 10 saves, 7 days, 7 mirror dailies.

**Three contradictions**
- §0.0h req. 4 says the callback "must be able to open … the local old VK at §3.5 join", so copies it cannot open are
  dropped. The code never asks it.
- §3.8 P4 and §3.9 R3 tell M2 to call `rewriteForKeyChange` after a rotation or adoption. That drops unknown-key copies
  (the opposite of `finishKeyChange`), leaves the marker set and does not write `sk_store_v`.
- §0.0h req. 6 says `sk_store_v` records the vkId once **every** copy (this store and the mirror) is under it. Since
  A2-1's fix, `store.ts:577` writes it when **this store** is clean and tracks the mirror with a mirror-only marker.
  The code is right; the document is stale.

**Also outside the protocol**: `sk_sync_cfg.enc` and `sk_prejoin`, which M2 adds. Both are VK-encrypted, and §2.5 and
§3.8 P4 re-encrypt them on a VK change. `staleIn` does not know them, so `finishKeyChange` removes the marker while they
may still be under the old VK. For §3.5, where the old VK is not in `previous`, `sk_prejoin` under the old VK would
become unreadable if this is ever wrong.

**Fix: a decision, then make the code and SYNC-DESIGN agree.** Old-vault snapshots are an intended data source.
§4.6's "find accounts" takes accounts from local snapshots, and accounts from a snapshot with another vaultId are added
in "added" mode. `recover()` cannot use them, since it matches `c.envelope.vaultId === src.keyring.vaultId`, but that
only rules them out as recovery sources. Split the rule by how the old vault went away:
1. **§3.5 join** (the local old VK is known at that moment): keep the snapshots and re-encrypt them under the new VK
   through a new input, `finishKeyChange(vk, reencrypt, { extraKeys: Vk[] })`, offered to the callback before "keep or
   drop". `housekeeping`'s `encryptVault(..., { vaultId: env.vaultId })` keeps the old vaultId in the header, which is
   exactly what §4.6's "added" mode needs. This is what §0.0h req. 4 intends, and the code cannot do it today.
2. **`startOver`** (a new vaultId; the user typed DELETE to erase the unreadable remains, and their key is gone): drop
   the old vault's unknown-key snapshots in the cleanup that the over-lost marker triggers. M2 caveat: if sync knows
   the lost vault, the Lost screen must offer cloud restore before `startOver` (Q3 item 10).
3. **Same-vault snapshots under an unknown key** (a NEWER key after a FIXa2 / recovery rollback, a restore over a lost
   vault of the same id): keep them, as now. M2 can bring the keyring back.
4. **Use `finishKeyChange`.** SYNC-DESIGN §3.8 P4 and §3.9 R3 should say `finishKeyChange`, not `rewriteForKeyChange`
   (that one is purge semantics).
5. **Register M2's copies.** Give the store an extension point, a list of extra VK-encrypted keys that `staleIn` and
   `rewriteInner` treat like snapshots, so the marker is not removed while `sk_sync_cfg.enc` or `sk_prejoin` is still
   under an old key. The alternative is that M2 keeps its own marker.
6. **Correct §0.0h req. 6** to the per-store meaning.

**Blocks M2**: yes, as a decision and doc change, before M2's adoption and join code.

### GM2-5 (Medium, M2 trap): FIXa2 against the IndexedDB identity pin; the spec's repair rule points the wrong way

**Where**
- `store.ts:199-200` (FIXa2).
- SYNC-DESIGN §2.5 "write order": transact the local keyring first, then update the pin (`vkId`, `maxSeenKver`,
  `adopted`) in **IndexedDB**.
- §3.9 "pin repair (D8)".
- §0.0f M2 req. 2.

**Failing sequence** (by construction: two separate LevelDB instances, each losing its own unsynced tail on power loss)
1. §3.8 P4 runs: the local transact commits (`sk_active` names VK2's slot), `startSession(VK2)` runs, and the IDB pin
   becomes VK2 with `maxSeenKver = k2`.
2. A power loss loses the tail of chrome.storage.local's log (the pointer write), but IndexedDB kept the pin.
3. At the next start, FIXa2 (or plain `load()`) keeps VK1: the keyring rolls back, the pin does not.
4. D8 only moves the pin forward when `unwrapPreviousVks(local keyring, local VK)` can unwrap it. VK1's keyring cannot
   unwrap VK2, so nothing happens.
5. The next sync sees the server bundle at VK2, `kver = k2 ≤ maxSeenKver`, and the bundle's vkId equals the pin.
   Every rule then assumes "pin = local VK":
   - R2 ("same VK as the pin") verifies the bundle's MAC with the local VK, which is VK1, so the result is **`bad_mac`**,
     the alarm for a tampering server;
   - a classification by content per R1 gives **`keys_behind`** ("the server's key state is older than this device").

   Which one comes out depends on how M1 / M3 order these checks.
6. Neither has an exit that works. "Repair the cloud from this device" (§4.2) is `POST /v1/keys/rotate` in repair use.
   Its `write_proof` must use the server's current `K_write = HKDF(VK2, …)`, which a VK1 device does not have (§2.2;
   `api/openapi.yaml` `/v1/keys/rotate`). `PUT /v1/keys` requires `keyring.vkId` to equal the server's `vk_id`. An
   honest server therefore refuses both, and the account key is not rolled back.

The device is stuck in a misleading state. It recovers only if the user happens to trigger R3: unlocking with the
password does not even try the server bundle, because the local wrap opens.

**Fix (spec, before M2 writes adoption code)**
- Add the second D8 branch. When `pin.vkId ≠ local keyring.vkId` and the pin is not reachable from the local keyring,
  the device is behind its own pin. Classify it as `needs_password` (R4), not `bad_mac` or `keys_behind`. Unlocking
  then tries the server bundle first and adopts it through R3. Its continuity check succeeds, because the server's
  keyring2 retired VK1 into `previous`.
- Alternatively, keep an authoritative copy of the pin in chrome.storage.local, written after the commit in the same
  log, so it can never be ahead of the local commit. IndexedDB then holds only the copy needed while locked.
- Add a fault test: drop the local tail and keep IDB.

**Blocks M2**: yes (spec).

### GM2-6 (Medium): P-9 is worse than reported: a fresh install whose IndexedDB always fails can never open or create a vault

**Where**: `store.ts:214-242`. P-4's fix throws `unread` when any recovery source threw and nothing usable was found.
`store.ts:281-285` (`hasAnyData`) is not even reached.

**Failing sequence** (probe "P-9 REPRO")
1. A fresh profile whose IndexedDB throws on every operation (Chrome's "Internal error opening backing store", the case
   A2-1 calls a real group of users).
2. `openView()` rejects with the IDB error, so the popup shows the error screen with Retry, forever.
3. `prepareKeys` works, but `create(keys)` throws inside `store.load()`. No slot is written.

The user can never use Sixkey on that profile. An existing user is unaffected while the active slot is readable.

**Fix**
- In `recover()`: when this store holds no vault key at all (no `sk_active`, slots, `sk_keyring` or `sk_snap_*`, which
  `hasAnyData` already checks), and only the mirror's reads threw, log it and return `empty`.
- Make the guarded mirror write in `transact` refuse to overwrite an existing mirror generation of **another vaultId**.
  Read `sk_mirror_gen` first; if it belongs to another vault, do not overwrite, log, and push an event. That way a
  mirror that comes back holding the only copy of an older vault is not destroyed by the new vault's first save. The
  extra mirror read is on the write path only, not in the open budget.

**Blocks M2**: no.

### GM2-7 (Low): the decrypt fallback skips candidates whose read throws, and commits an older copy

**Where**: `store.ts:727-747`. `snapshotCandidates()` is called with the no-op `skipped`, and `readMirrorGen()` only
logs.

**Failing sequence** (probe "Q2 REPRO: the decrypt fallback …")
- The setup:
  - the active copy passes its checksum but does not open;
  - the other slot is torn;
  - there is no mirror generation;
  - the read of the newest snapshot throws once.
- The fallback restores the snapshot before it and commits it. The view lacks the last account, with a `decrypt_fallback`
  notice.
- The newer record stays on disk for now, but every later save builds on the older data, and it ages out.

This is the same rule P-4 fixed in `recover()`: a read that throws must not make an older source win.

**Fix**: collect skipped reads in `openVault`. If any read threw and the candidate that opens is not the newest one,
throw (the popup shows Retry) instead of committing.

**Blocks M2**: no. Fix it inside M2's previous-VK fallback change to `openVault`, which extends this exact loop.

### GM2-8 (Low): `selfCheck` overwrites a mirror generation that is newer than both slots

**Where**: `store.ts:271-276` (heal mirror: `m.seq !== gen.seq` → overwrite).

**Failing sequence** (probe "selfCheck overwrites a mirror generation that is newer")
1. A power loss drops the tail of chrome.storage.local's log, including the last save.
2. IndexedDB, a separate LevelDB, kept that save's mirror write.
3. At the next browser start, `recover()` picks the older slot (correct by the rules), and "heal mirror" overwrites the
   newer mirror generation.

The save the user saw succeed is now gone everywhere.

**Fix**: when `m.seq > gen.seq` and it is the same vault, keep it.
- Simplest: write `m.envelope` as a rolling snapshot record first, which is data only and fits the existing limits.
- Or apply the slot rule: same keyring, highest seq wins.

**Blocks M2**: no. M2's server copy is the better source; `beforeRecoveryWrite` must still see this write.

### GM2-9 (Low): `purgeForever` interrupted after its edit committed leaves the secret in live copies, and nothing retries

**Where**: `service.ts:587-605`. The purge is two steps, `mutate` and then `rewriteForKeyChange`, with no marker
between them.

**Failing sequence** (probe "purgeForever interrupted …")
1. The process dies at the first write of the rewrite.
2. After a restart, an unlock and an open, the UI shows the account erased.
3. The other slot and the snapshots still hold the secret. Nothing retries; they age out over 10 saves or 7 days.

The crash matrix confirms that every crash point keeps the vault consistent, so this is about the promise "erased from
every copy Sixkey keeps", not about data loss.

**Fix**: write a purge marker, e.g. `sk_purge_pending: {ids}`, in the same transact as the edit; re-run the rewrite at
the next open or unlock; clear the marker last. Or document the crash case in SECURITY.md.

**Blocks M2**: no.

### GM2-10 (Low): `touch()` racing `lock()` in another context puts the raw VK back into `chrome.storage.session`

**Where**: `service.ts:213-216` (read, then write, under no lock) and `session.ts:47-54`.

**Failing sequence** (probe "touch() racing lock()")
1. The popup's `touch()` reads the session.
2. The service worker locks on screen lock: it clears the session and bumps the epoch.
3. `touch()` writes the old session back.

The raw VK sits in `storage.session` again, with a stale epoch. Every `currentVk` / `sessionVk` voids it and clears it,
but `enforceAutoLock` (`service.ts:223-230`) checks expiry only, so it stays until the next page check.

**Fix**: in `touch()`, write only if `lockEpoch() <= s.epoch`, re-read after the write and clear if it moved;
`enforceAutoLock` also clears a stale-epoch session.

**Blocks M2**: no. M2's SW sync rounds go through `requireVk`, which voids it.

### GM2-11 (Low, M2 trap): `VaultStore` defaults to a per-instance mutex

**Where**: `store.ts:120` (`this.lock = o.lock ?? createMutex()`). Only `runtime.ts:22` passes
`webLock("sixkey-vault")`.

**Sequence**: any second `new VaultStore({ kv })` that M2 adds (an SW sync module, a migration) silently runs its
transacts and cleanups outside the cross-context lock. §0.0h req. 3 depends on this, and nothing enforces it.
`webLock` also falls back to a per-context mutex when `navigator.locks` is missing.

**Fix**: make `lock` required in `StoreOptions` (tests pass `createMutex()` explicitly), or add a unit test that greps
`src/` for `new VaultStore(` outside `platform/runtime.ts`.

**Blocks M2**: yes. It is one line, and req. 3 is otherwise unenforced.

### GM2-12 (Low): test gaps in the new rules (mutants that survive the package's own tests)

See §Q5:
- **X4** (no redundancy repair in the FIXa2 branch) survives every package test. Only this review's lying-disk probe
  kills it.
- **B3** (FIXb narrowed to vkId changes) survives everything except this review's late probe "a reset whose pointer
  write lands and still reports an error". The package's FIXb test uses `rotateKey` only, so FIXb for the three same-VK
  operations is unpinned. Under B3, that reset leaves R1 dead with R2 never shown.
- **K6** (the keyring copy healed only when missing, not when it differs) survives every package test. Only the
  review's lying-disk probe and the matrix's triple check kill it.
- **C4** (the mirror generation written before the commit) survives everything, including this review.
- **X3** (FIXa2 by vkId) is killed by exactly one test ("the cost …"), which GM2-3's fix rewrites. Keep a same-VK FIXa2
  case after that change.

**Fix**
- Move the review's probes "a lying disk …", "a reset whose pointer write lands …" and the GM2-2 leftover probe into
  `a2-review.test.ts`.
- Add the crash matrix (Appendix C) to `test/fault/`. It runs in about 57 s.
- Add a C4 test: write order, where the mirror generation is written only after `sk_active`.

**Blocks M2**: no.

### GM2-13 (Low): the popup's password reset shows the new recovery code in the popup

**Where**: `popup/screens/Locked.tsx:33-41,56-68`.

**Sequence**
1. A user resets the password in the popup and gets R2.
2. They switch to their password manager to save it; the popup loses focus and closes, and R2 is gone.
3. R1 (just used) is dead. P2 opens the vault, and there is no working recovery code until the user notices and makes a
   new one.

This is the exact reason A1 moved first-run to a tab (PHASE0X-PLAN A1, "why a tab, not the popup"). It predates A1/A2.

**Fix**: the reset opens the options page in a tab (`#reset`), or uses GM2-1(c)'s show-before-commit.

**Blocks M2**: no.

### GM2-14 (Info): `pushEvent` replaces unacknowledged events after a failed read

**Where**: `store.ts:761-776`. `readEvents()` swallows a throw and returns `[]`.

**Sequence**
1. Two notices are unacknowledged, say a `slot_fallback` and a `snapshot_restore`.
2. A later recovery, such as a decrypt fallback, calls `pushEvent` while the read of `sk_events` throws once.
3. `sk_events` becomes `[that one event]`, and the two earlier notices are gone without ever being shown.

Events are notices, not vault data.

**Fix**: read strictly inside `pushEvent` and, on a throw, skip recording (log).

**Blocks M2**: no. Per I12, M2 must not derive sync state from events anyway.

### GM2-15 (Info): P-8 still open: the 65th rotation fails with a raw `verify_failed`

**Where**: `keyring.ts:125` (`validateKeyring` rejects more than 64 `previous` entries), `keyring.ts:258-271`
(`rekey` appends the retired VK with no cap, `:269`) and `store.ts:425` (`transact`'s `checkGeneration`).

**Sequence**
1. A vault has been rotated 64 times, so its keyring lists 64 `previous` entries.
2. The user runs `rotateKey` again.
3. `rekey` returns 65 entries, and `transact` throws `StorageError("verify_failed")` before the marker write, so nothing
   is written.
4. The user sees an internal error and can never rotate again.

**Fix**: M2's `capPrevious` must run in the Phase 0 local `rotateKey` and `enableMasterPassword` too. Before it drops a
VK, the pending cleanup must have finished; otherwise snapshots still under that VK become "unknown" and are kept
unreadable.

**Blocks M2**: no. It is already an M2 work item (§3.8 P1); the Phase 0 paths are in the checklist.

### GM2-16 (Info): A2-9 `touch()` costs 2 local reads

**Where**: `service.ts:213-216` and `session.ts:39-49`.

**Sequence**: the popup opens unlocked and the list renders. `App.tsx:25` then calls `touch()`, and
`RoutedSession.always()` reads `sk_settings` once in `get` and once in `set`. The probe counts 2 local reads.

They come after the first frame, and `perf.spec.ts` allows "at most 6 in all (touch() adds 2)". `openView` itself also
reads the settings twice (A2-9) and still meets the 4-read gate.

**Fix** (optional): pass the settings already read, or read the mode once per call.

**Blocks M2**: no.

## Q1. Every key-changing operation through every crash point (FIXa2 and FIXb)

Method: the Proc model of `keychange-marker.test.ts`. One process for local storage, the mirror and the session dies at
write N, before or after it lands. Then either:
- **restart**: session cleared, `selfCheck`, then what `load()` sees;
- **no restart**: a page died; the popup opens.

Then unlock with whatever the user holds. Results in Appendix A.

| Operation | Writes (commit at) | Rolled back | Committed, never shown | Credential that opens the committed state | Other slot differs after the next open/unlock |
|---|---|---|---|---|---|
| enableMasterPassword | 20 (3) | 10 points | 70 (35 distinct writes) | the typed password; the code nobody saw | 2 (FIXa2 leftover: a device vault keeps the rejected slot and its marker) |
| rotateKey | 20 (3) | 10 | 70 (35), **old code dead** | the password | 0 (the vkId marker cleans it) |
| changePassword | 5 (2) | 6 | 14 | the typed password, and the old code | 10 = 2 FIXa2 leftover (1a, 2b) + 8 P-5 |
| resetPasswordWithRecovery | 5 (2) | 6 | 14 (7), **old code dead** | the typed password | 10 = 2 + 8 |
| newRecoveryCode | 4 (2) | 6 | 10 (5), **old code dead** | the password | 8 = 2 + 6 |
| purgeForever | 17 (2) | 68 (consistent; the purge incomplete, GM2-9) | — | unchanged | 0 |
| restoreBackup over lost | 7 (3) | 6 (still "lost") | 22 "landed": the code was confirmed before | the typed password, the confirmed code | 0 |
| startOver over lost | 7 (3) | 6 | 22 "landed" | the same | 0 |

**Answers**

**(a) Unreadable with every credential the user holds or was shown?** Under process death and I/O errors, no. At all
356 points some credential the user holds opens the vault: the old one if nothing committed, otherwise the password
they typed or kept.

The one way to it is a power loss that drops writes the page already reported as done. That is FIXa2's accepted cost,
and also plain tail loss without FIXa2:
- a **reset** the user saw succeed is rolled back to the forgotten password and to R1;
- a user who already replaced R1 with R2 is then locked out.

GM2-2(b) makes that visible; GM2-2's optional roll-forward removes it.

**(b) An unconfirmed recovery code as the only way in?** Never the only way: the password still works. But the
user's saved code being silently dead is common across the commit-then-show window (GM2-1), and it becomes the only way
the day the password is forgotten. After FIXa2 for same-VK changes, the unseen-code keyring waits in the other slot and
is committed by a later pointer-slot fault (GM2-2, probe).

**(c) Data the user saw saved silently rolled back?** Not by FIXa2.
- A save's target is always the slot the pointer does not name. So the first ordinary save after a key change
  overwrites the old-keyring slot.
- From then on, both slots carry the new keyring, and FIXa2's "keyrings differ" condition can no longer fire.
- The only state in which the pointer names an older-keyring slot is "no save landed after the key change". FIXa2 then
  rolls back nothing but the key change.

Probes:
- "rotation whose cleanup failed, 1 or 2 saves, the last save's pointer write lost": every account kept, and the triple
  consistent;
- a lying disk that drops only the key change's pointer write while later writes land: the K2 session no longer
  matches K1, so no save can land under the dropped key, and nothing is lost.

Mutant X2 ("the pointer always wins") loses those saves and is killed. Two data rollbacks exist, both outside FIXa2 and
both Low: GM2-8 (a newer mirror generation is overwritten) and GM2-7 (the decrypt fallback after a read error).

**(d) A device key or old-key copy left without a marker?** No, by vkId:
- the marker promise held at every matrix point, and every device key was gone after the next cleanup;
- the device-vault rollback (`enableMasterPassword` dies between slot and pointer) keeps a device vault, whose device
  key is current, not stale.

For same-VK changes the old wrap stays with no marker, by design today. That is GM2-3: not "old key" material by vkId,
but material that opens the current data with a superseded secret.

**The pointer / slot / keyring-copy triple**
- After `selfCheck` it was consistent at every restart point. That includes the lying-disk case, where before
  `selfCheck` the keyring copy and the mirror carried K2 while the pointer slot carried K1.
- `restoreRedundancy` in the FIXa2 branch heals both. Mutant X4, which removes that, is killed only by the review probe
  (GM2-12).
- Between a non-sequential loss and the next `selfCheck`, the triple is out of step. A double fault in that window, both
  slots then damaged, would let `recover()`'s "both slots unusable" branch pick the newer K2 keyring copy and its K2
  snapshot. That needs a non-sequential loss plus two damaged slots, so I note it and do not rate it.

**Snapshots from before the change**: after a rollback they are under K1, current. After a committed change whose
cleanup has not run, they are under a key in `previous` and are re-encrypted by the next cleanup (P-7 holds in
`purgeForever`). A K2 snapshot kept after a K1 rollback is "unknown" and is kept, which is A2-4.

**FIXb**
- It writes `prev` back only for keyring changes (`store.ts:446`). A decrypt fallback keeps the restored copy
  (a2-review test; mutant B2 killed).
- When the pointer write landed and threw, the target ends up holding `prev`, which matches what the user was told.
- The remaining hole is a double fault: the pointer lands and throws, and the write-back fails too. The change is then
  active while the user was told it failed, the GM2-1 outcome.
- It is unpinned for same-VK changes (B3, GM2-12).

**`selfCheck`, `recover`, decrypt fallback.**
- `recover()` and `load()` now agree for keyring changes.
- `recover()` writes neither the marker nor `sk_store_v`, so `loadView`'s single read stays valid (`store.ts:163`).
- The decrypt fallback writes only envelopes under the current VK, with the current keyring (I1 holds), so FIXa2 never
  fires on it.

## Q2. The merged A1 + A2 service and store

**Handle use-once semantics against the marker writes: sound.**
- `makeVault` spends the handle only after `startSession` (`service.ts:309-310`). Mutant S1 checks this.
- A transact that wrote the marker over lost data and then failed leaves an extra marker plus an unspent handle. The
  retry rewrites the marker, and an extra marker costs one idempotent cleanup.
- A write that landed is recognised as `LANDED` (canonicalJson of the keyring), both before the lock and inside it.
- The crash matrix rows "restoreBackup / startOver over lost" find either "still lost" or "a vault that the confirmed
  code and the typed password open", never anything else.

**startOver / restoreBackup over lost data, and "keep and report"**
- The marker is written, because `cur.status === "lost"` counts (mutant K5).
- `seq` continues above the highest snapshot (P-6).
- The in-lock recheck refuses a vault that appeared meanwhile.
- The lost vault's snapshots are kept as "unknown key" and reported. After `startOver` (a new vaultId) they can never be
  restored, and the user typed DELETE to erase them: see Q4 A2-4 and GM2-4 item 2.
- `restoreRedundancy` and the cleanup overwrite the damaged other slot. A damaged record can still hold a readable
  `deviceKey`, so this matters (`staleIn` counts `!ok` as stale).

**Concurrency across contexts**
- The popup, options page and SW all build the store through `createRuntime` with `webLock("sixkey-vault")`
  (`runtime.ts:22`, `sw.ts:5`, `popup/App.tsx:12`, `options/App.tsx:37`).
- Every read-modify-write of vault keys is inside it: `transact`, `finishKeyChange`, `loadView`, `load`, `selfCheck`,
  `ensureDailySnapshot`, `scrubStaleDeviceKey`, `rewriteForKeyChange`, `ackEvents`, and `pushEvent` from
  `openVault`.
- `openVault`'s candidate reads are outside the lock, but its write is a `transact`, and `checkGeneration` rejects an
  envelope whose key no longer matches (A2 review, M11).
- Two setup tabs: the loser is refused before `saveChoice`; covered by store-misc and firstrun e2e.
- Gaps: the default per-instance mutex (GM2-11), and session writes under no lock at all (GM2-10).

**lockEpoch**: `startSession` records the epoch, and `currentVk` and `sessionVk` void a session behind it.
`RoutedSession.clear` bumps it, so a lock in the SW reaches a key held in a page's memory in "always" mode. The bump is
a read-modify-write without a lock, but two concurrent bumps still move the epoch past every earlier session.

**openView and unlock paths**
- `openView` runs the full cleanup only for password vaults.
- `finishUnlock` runs it for "full" and "mirror".
- `housekeeping` never fails the open or the unlock.
- An unlock that races a rotation in another context opens the stale view, and `finishKeyChange` returns `done: false`
  for the old VK (`store.ts:553`).

**Reads that throw**
- They propagate in `loadView`, `loadInner`, `recover` (P-4), `finishKeyChange` / `staleIn`, the strict rewrite,
  `addSnapshot` (P-2) and `highestSnapshotSeq` (the primary store).
- The exceptions are:
  - `openVault`'s fallback (GM2-7);
  - `pushEvent` (GM2-14);
  - "heal mirror", whose swallowed read only leads to the same overwrite a successful read would (GM2-8 is the real
    problem there);
  - `snapshots()`, display only.

## Q3. The hand-off to M2

### SYNC-DESIGN §0.0h / §0.0f "M2 requirements" against the merged code

| Requirement | Code | Status |
|---|---|---|
| Key-changing writes go through `transact`; `sk_keychange = {v:1, vkId, at}` before the slot write; a failure to write it fails the save | `store.ts:428-434` before `:437`, not caught | **holds** (mutants K1 and K3 in §Q5) |
| "Key change" = vkId change, device wrap gone, lost data overwritten | `store.ts:428-430` | holds as written, but **too narrow for same-VK adoption** (GM2-3) |
| Writes that keep the key but leave old copies use `transact({keyChange:true})` | `store.ts:411,428` | the marker is written; **the cleanup ignores same-VK differences** (GM2-3) |
| Every `VaultStore` uses lock name `sixkey-vault` | `runtime.ts:22` | holds today; **unenforced** (GM2-11) |
| Re-encrypt callbacks open all previous keys, plus §3.5's old local VK | `service.ts:355-361` (`housekeeping`), `:480-486` (`scrub`), `:595-604` (`purge`) | all `previous`: **holds**. §3.5's old VK: **the callback is never asked** (GM2-4) |
| Adopting a keyring that does not list the local key: the cleanup is triggered only by the marker | `cleanupNeeded`, `store.ts:95-100` | holds (the version rule only recognises listed keys) |
| `sk_store_v = {v:2, vkId}`, written only by a finished cleanup in the same locked step; marker deleted last | `format.ts:60-66`, `store.ts:577-583` | holds. Written when **this store** is clean, with a mirror-only marker for the mirror (A2-1); **§0.0h req. 6's wording is stale** (GM2-4) |
| `DeviceIdentity.vaultId`, `adopted`; one IDB write with `vkId`, `maxSeenKver`, after the transact | not present (M2) | M2 adds; see GM2-5 for the ordering trap |

### What M2 must change or add
1. Before M2, from this review: GM2-1(a) and (b), GM2-3, GM2-4 (the decision and doc), GM2-5 (spec), GM2-11.
2. **`DeviceIdentity`** in IDB `sixkey-identity` with `vaultId` and `adopted {digest, auth}`, written in one IDB write
   with `vkId` and `maxSeenKver`, only after the local `transact` returned. On restore from `sk_sync_cfg`: `vaultId`
   from the local keyring, `adopted = null`, `maxSeenKver = 0`. Digests only through M1's `adoptedRecord`. Plus the
   second D8 branch (GM2-5).
3. **`transact` options `ensureCurrentSnapshot` and `afterCommit`** (§4.6, §4.7). `afterCommit` runs inside the lock,
   after the commit, and **guarded exactly like the redundancy writes**: a failure must never fail a committed save,
   or it reproduces GM2-1.
4. **The `VaultStore.beforeRecoveryWrite` hook** (I12). It must fire before every recovery write:
   - `recover()`'s pointer fix-up (`store.ts:202`), including the slot FIXa2 chose;
   - `writeBoth` (`:387-395`);
   - `restoreRedundancy`'s heals;
   - GM2-2's overwrite of the rejected slot;
   - the decrypt fallback's `transact` (`:741`).
5. **The `openVault` previous-VK fallback** (I3). Decrypt with the previous VK, re-encrypt to the current VK before
   writing (`checkGeneration` rejects a mismatched envelope and keyring), then
   `transact(..., { keyChange: true })`. Fix GM2-7 in the same loop.
6. **`service.applyRemote`**: no network inside the `transact` callback (the lock is cross-context); `requireVk`
   inside; the guard; "no change" returns the original envelope (I10).
7. **Keyring adoption** (R2, R3, R6, §3.5, §3.3, cloud restore) as store-level transacts.
   - Never through Phase 0 `changePassword`, `newRecoveryCode` or `rotateKey`: those require the old password and
     commit before showing.
   - R2 forbids replacing a proven password wrap before the user proves the new one.
   - After each one, call `finishKeyChange` (not `rewriteForKeyChange`) with every key that may be left: `previous`,
     plus §3.5's old local VK through the `extraKeys` input (GM2-4).
8. **`capPrevious` before every rotation transact**, the Phase 0 local paths included (GM2-15). Finish the pending
   cleanup before a previous VK is dropped.
9. **Register `sk_sync_cfg.enc` and `sk_prejoin` with the marker protocol** (GM2-4 item 5), so the marker is not
   removed while they are still under an old VK.
10. **Lost state with sync**: the Lost screen must offer cloud restore (§4.13) before `startOver`, which mints a new
    vaultId.

### What M2 can reuse as is
- `transact(fn, { keyChange })`: marker before the commit, FIXb, verify-then-flip.
- `finishKeyChange(vk, reencrypt)`: locked cleanup, mirror-only marker, `sk_store_v`, marker last, read errors
  propagate.
- `loadView` / `openView` / `finishUnlock`: the single-read open with cleanup scheduling.
- `openVault(vk, known)`: the fallback skeleton.
- `rewriteForKeyChange(…, { all })`: purge semantics only.
- `unwrapPreviousVks`, `rekey`, `setPassword`, `setRecovery` (`keyring.ts`, unchanged).
- The `prepareKeys` / `makeVault` pattern (opaque one-shot handle, show before commit, `LANDED` idempotency, session
  before spend) for every "commit after the user confirmed a code" flow.
- `StorageEvent` / `pushEvent` / `ackEvents` for user notices (I12).
- `both()`.
- `currentVk` / `requireVk` with `lockEpoch` as the sync engine's guard.

### Traps in the code that would make M2 break an invariant
1. **The default lock** is a per-instance mutex (GM2-11).
2. **FIXa2 against an identity written in another database** (GM2-5).
3. **Keyring byte stability.** FIXa2, FIXb and (after GM2-3) the marker compare `canonicalJson(keyring)`. If M2 puts
   anything per-save into the keyring (a timestamp, a sync field), every ordinary save becomes a "keyring change":
   - FIXa2 rolls ordinary saves back on a lost pointer write;
   - FIXb writes `prev` back on every I/O error;
   - after GM2-3, every save writes a marker and runs a cleanup.

   Keep sync state out of the keyring (`sk_sync_*`).
4. **`keyChange: true` is a no-op for same-VK changes** until GM2-3.
5. **Unknown-key copies are never offered to the callback**, and `rewriteForKeyChange` drops them (GM2-4).
6. **Steps after a commit that can throw** (`startSession`, `afterCommit`, the pin write) report "failed" for a
   committed keyring (GM2-1). Per I2, they must be non-fatal.
7. **The 64 cap.** `validateKeyring` rejects more than 64 `previous` entries. `rekey` adds one, so a keyring at 64
   cannot be rotated: `verify_failed`, nothing written (GM2-15). Do not assume `previous.length` stays at or below 64
   after `rekey`; call `capPrevious` before the transact.
8. **`sessionVk` duplicates `currentVk`** (`service.ts:186-200`): any change to the session rules must touch both, and
   `open-view-diff.test.ts` is the guard.
9. **Single-device assumptions.**
   - `seq` is a per-store counter; never compare it across devices.
   - `recover()` orders keyring sources by local `savedAt` (wall clock).
   - `hasAnyData` and `sk_store_v` are per store.
   - `sk_device` is the HLC tiebreaker, not the sync identity (§2.5).
10. **Phase 0 password-wrap rules.**
    - `changePassword` needs the old password; there is no "replace the wrap with one the user proved" operation.
    - With P-5 unfixed, an adopted remote password change leaves the leaked old password able to open the current
      local data from the other slot.

## Q4. Known open items

- **P-5: fix it, in the GM2-3 patch.**
  - The security impact is in GM2-3: the old password or code plus a profile copy taken before the next save opens the
    current data from a live record, not from residue. Same-VK changes never protected against someone who already had
    the VK, so this is Medium, not High.
  - It must be fixed before M2's same-key adoption. Otherwise M2's documented hook does nothing for that case, and a
    remote password change made because the old one leaked leaves that password working on every other device until
    each one's next save.
- **A2-4 (keep and report snapshots under an unknown or newer key): keep for the same vault, drop for another vault.**
  - **Bounded.** The probe shows `startOver` over a lost device-key vault keeps that vault's rolling snapshots. Anyone
    holding the old device key opens them with no password. The old device key can come from LevelDB residue, an
    earlier profile copy, or a damaged-but-readable slot record before the cleanup overwrites it. Ten saves push them
    out; daily ones last 7 days, plus 7 mirror dailies.
  - **The trade-off.** Keeping them protects data that a returning keyring could still open, which only M2 can bring
    back. But:
    - a device-key VK's keyring never comes from the server, because H1 requires a password for sync;
    - an old-vault snapshot (another vaultId) can never be restored by `recover()`.
  - **Recommendation** (GM2-4):
    - **`startOver`**: drop the old vault's unknown-key snapshots in the cleanup the over-lost marker triggers. The user
      typed DELETE, the key is gone, and this closes the probe's case.
    - **§3.5 join**: keep them and re-encrypt them under the new VK through `extraKeys`, so §4.6's "find accounts" can
      add them in "added" mode.
    - **Same-vault unknown-key snapshots**: keep them. That covers `restoreBackup` of the same vault and newer-key copies
      after a rollback. SECURITY.md should state the residual for "restore over a lost device-key vault": its old
      snapshots stay readable to a holder of the old device key until they age out.
    - **Test it end to end**: make `residue.spec.ts`'s start-over case start from a device-key vault. Today it seeds a
      torn slot only, so this scenario is untested end to end.
- **P-9: worse than the A2 review said** (GM2-6, Medium). Fix it with the "nothing here, mirror unreadable → empty"
  rule plus the "never overwrite another vault's mirror generation" guard. It does not block M2.
- **A2-9 (`touch()` reads): 2 local reads after the first frame, within `perf.spec`'s "6 in all".** Info (GM2-16).
  There is a real but unrelated issue in `touch()`: the lock race, GM2-10.

## Q5. Mutation testing

Each mutant was one exact replacement in a fresh copy of the merged tree. It ran against:
- **pkg**: the package's whole vitest suite, without the review files and without the M1 `sync-crypto-*` / `contract-*`
  files, which do not touch this code: 725 tests;
- **review**: `gm2-review.test.ts` and `gm2-crash-matrix.test.ts`.

Runner: `gm2-mut-run.py`.

"Killed by" names the tests that failed. "review" includes the late probe that pins FIXb for same-VK changes; B3 and C4
were re-run with it.

| Id | Mutation | pkg | review | Killed by |
|---|---|---|---|---|
| X1 | FIXa2 removed | killed | killed | a2-review "FIXa2: after that, a browser restart …" and 2 more; review: the silent-rollback and leftover probes |
| X2 | FIXa2 widened: the pointer always wins (FIXa) | killed | killed | a2-review "an ordinary save … the self-check commits the newer slot"; review Q1(c) probes (saves lost) |
| X3 | FIXa2 compares vkIds instead of keyrings | killed | killed | **one** test, a2-review "the cost (owner's decision) …" (reset); review leftover probes |
| X4 | no `restoreRedundancy` in the FIXa2 branch | **survived** | killed | review lying-disk probe only (GM2-12) |
| X5 | `recover()` no longer moves the pointer | killed | killed | store.test crash matrix (9 tests) |
| B1 | FIXb removed | killed | survived | a2-review "FIXb: a pointer write that lands …" |
| B2 | FIXb for every save, not only keyring changes | killed | survived | a2-review "FIXb only for keyring changes: a decrypt fallback …" |
| B3 | FIXb by vkId (same-VK changes not reverted) | **survived** | killed | review "a reset whose pointer write lands and still reports an error" only (GM2-12) |
| C1 | pointer written before the read-back check | killed | survived | store.test "a store that drops the slot write is detected before the pointer moves" |
| C2 | pointer written before the slot | killed | killed | 13 package tests; review matrix |
| C3 | keyring copy written before the slot | killed | survived | create-crash (4) |
| C4 | mirror generation written before the slot | **survived** | **survived** | nothing pins "the mirror is written after the commit" (GM2-12) |
| K1 | marker written after the commit | killed | killed | keychange-marker crash matrix and 6 more; review matrix |
| K2 | marker removed before the rewrite | killed | survived | keychange-marker / a2-review mirror and read-error tests (6) |
| K3 | a failed marker write is swallowed | killed | survived | keychange-marker "a failure to write the marker fails the key change …" (one test) |
| K4 | cleanup ignores the marker | killed | killed | 20 package tests |
| K5 | overwriting lost data writes no marker | killed | survived | keychange-marker "restoreBackup over lost data writes the marker …" (one test) |
| K6 | keyring copy healed only when missing (not when it differs) | **survived** | killed | review lying-disk probe and matrix triple check only (GM2-12) |
| S1 | A1 handle spent before the session write | killed | survived | create-crash "storing the session fails after the commit" (4) |
| S2 | `recover()` swallows unread sources again (P-4 undone) | killed | killed | a2-review P-4; review P-9 probe flips |

**Totals**: 20 mutants. The package's tests kill 16; the survivors are X4, B3, C4 and K6. With the review's probes, 19
are killed and only C4 survives.

C4 is benign in single faults: `selfCheck` re-heals the mirror. It matters only in a double fault, a failed commit and
then both slots damaged, where `recover()` would then restore the uncommitted generation from the mirror.

Several rules hang on exactly one test: X3, K3, K5, B1 and B2.

## Checked and found sound
- **FIXa2's scope.**
  - It fires only when the pointer names a valid slot and the newer slot carries a different keyring (canonicalJson,
    so same-VK changes too).
  - A tie goes to the pointer slot, and ordinary saves keep "highest seq wins" (the a2-review test, X2 killed).
  - `selfCheck`, every `load()` and the marker cleanup now agree on keyring changes.
- **No data the user saw saved is rolled back by FIXa2** (Q1(c)).
- **FIXb**: keyring changes only; it keeps the decrypt-fallback copy (B2 killed); it is best effort and does not mask
  the first error.
- **Commit order**: marker, slot, read-back verify, pointer, then the guarded redundancy writes, with the keyring copy
  and the mirror after the commit. C1, C2 and C3 are killed. The mirror's place in that order is right but unpinned
  (C4, GM2-12).
- **Marker protocol by vkId**: written before the commit, a failed write fails the save, cleared last under the lock,
  the mirror-only state, the one-time check, and an older version's key change.
- **Crash matrix**: 8 operations, 356 points. Every account is kept, some held credential opens the vault, the triple is
  consistent after `selfCheck`, the marker promise holds, and no device material remains after the cleanup.
- **A1's handle semantics with the marker**: spent only after the session; `LANDED` before and inside the lock; an
  extra marker after a failed write over lost data is harmless.
- **Locks and the epoch**: every read-modify-write of vault keys is locked, the lock name is the same in all three
  contexts, the epoch voids keys in other contexts, and `both()` waits for `openVault`'s possible write.
- **Reads that throw**: they propagate on every path that can write, except GM2-7 and GM2-14.
- **Plan constraints**: no change to permissions, CSP or network; the popup is 54.4 KB gz, under 60.

## M2 hand-off checklist (precise)

**Before M2 starts**
1. **GM2-1(a) and (b).**
   - In `enableMasterPassword`, `rotateKey`, `changePassword` and `resetPasswordWithRecovery`, a `startSession` failure
     after the commit is logged, not thrown. Probe "Q1(b)" must then show the code returned.
   - The cleanup after a key change is not awaited before the result is returned (fire and forget, or a separate call
     the page makes after showing the code). The marker covers a page that dies first.
2. **GM2-3.**
   - The marker is written whenever `canonicalJson(prev.keyring) !== canonicalJson(next.keyring)`.
   - `staleIn` compares whole keyrings.
   - The three same-VK operations run the cleanup **after** their result is returned (item 1). The fix experiment
     awaited it and widened the never-shown window; see Appendix D.
   - The two pinned tests are updated, and the P-5 probes become regression tests.
3. **GM2-4: decide and write it into SYNC-DESIGN.**
   - (i) After `startOver`, the old vault's unknown-key snapshots are dropped by the cleanup. After a §3.5 join they are
     kept and re-encrypted for §4.6.
   - (ii) Same-vault unknown-key snapshots are kept.
   - (iii) `finishKeyChange` gets `extraKeys`.
   - (iv) §3.8 P4 and §3.9 R3 say `finishKeyChange`.
   - (v) M2's VK-encrypted keys (`sk_sync_cfg.enc`, `sk_prejoin`) are registered with the cleanup.
   - (vi) §0.0h req. 6 reworded to the per-store meaning.
4. **GM2-5**: D8's second branch ("pin ahead of the local keyring → `needs_password` / R3"), or an authoritative pin
   copy in chrome.storage.local, plus the fault test.
5. **GM2-11**: `StoreOptions.lock` is required, or a test checks that only `platform/runtime.ts` constructs a
   `VaultStore`.

**While building M2**
6. **`transact` options `ensureCurrentSnapshot` and `afterCommit`.** `afterCommit` runs inside the lock and is
   guarded. Test: a throwing `afterCommit` does not fail the save.
7. **`beforeRecoveryWrite`** at every recovery write: Q3 item 4 lists the five sites. Test: each recovery branch of
   `open-view-diff` calls it.
8. **The previous-VK fallback in `openVault`**: re-encrypt to the current VK, `keyChange: true`, read errors propagate
   (GM2-7).
9. **Adoption transacts** (R2, R3, R6, §3.5, §3.3, cloud restore):
   - the marker is automatic;
   - `startSession` and the pin are non-fatal and come after the commit;
   - `finishKeyChange` gets every possible old key;
   - never through the Phase 0 key-change methods.
10. **Sync state stays out of the keyring**, which must be byte-stable across ordinary saves.
11. **`capPrevious`** in every rotation, Phase 0 local ones included, after the pending cleanup has finished.
12. **The `DeviceIdentity` fields and write order** per §0.0f M2 req. 1–5. Pin repair runs in both directions.
13. **No network inside a `transact` callback.**
14. **Keep `sessionVk` and `currentVk` in step.**

**Before release (A1/A2 to users)**
15. GM2-1(d) or (c): no code shown in the popup, and show before commit.
16. GM2-2: the rejected slot overwritten, plus the `keychange_rolled_back` event and notice.
17. GM2-6 (a fresh install with a broken IndexedDB).
18. GM2-12: the review probes and the crash matrix moved into the package's tests.

**Follow-ups**: GM2-7, GM2-8, GM2-9, GM2-10, GM2-13, GM2-14, GM2-15, GM2-16.

## Closing verdict

**M2 AFTER FIXES.**

FIXa2 and FIXb do what they were meant to:
- the crash matrix holds every hard invariant at all 356 points;
- FIXa2 cannot roll back data the user saw saved after a key change.

M2 should not start until the five items under "Before M2 starts" are done. All of them are small code changes or
SYNC-DESIGN decisions:
- GM2-1(a) and (b);
- GM2-3;
- GM2-4;
- GM2-5;
- GM2-11.

| Severity | Count | Findings |
|---|---|---|
| Critical | 0 | — |
| High | 1 | GM2-1 |
| Medium | 5 | GM2-2, GM2-3, GM2-4, GM2-5, GM2-6 |
| Low | 7 | GM2-7, GM2-8, GM2-9, GM2-10, GM2-11, GM2-12, GM2-13 |
| Info | 3 | GM2-14, GM2-15, GM2-16 |

Blocks M2: GM2-1 (a and b), GM2-3, GM2-4, GM2-5 and GM2-11. None of the others blocks M2.

**Top 3**
1. **GM2-1 (High): the commit-then-show window.** A committed key change whose new recovery code never reaches the
   user leaves the saved code silently dead. This happens at 35 of 41 crash points of a rotation, and also when
   `startSession` throws after the commit.
2. **GM2-3 (Medium): same-VK keyring changes are outside the marker protocol.** P-5 stays open, and the documented M2
   hook does nothing for a same-VK adoption.
3. **GM2-4 and GM2-5 (Medium, spec decisions).**
   - GM2-4: unknown-key copies are never offered to the callback, which contradicts §0.0h req. 4. §3.8 and §3.9 name
     the wrong cleanup function.
   - GM2-5: a power loss can leave the IndexedDB pin ahead of a rolled-back keyring, with no rule to recover.


## Appendix A: crash-matrix results (merged tree)

**How to read the outcomes**
- **Points**: write N, before (b) or after (a) it lands, each with a browser restart (session cleared, `selfCheck`) and
  without one (the popup opens).
- **"rolled back / unchanged"**: the active keyring is the one before the operation. For `purgeForever` it means the
  vault is consistent; the purge is complete only if the run completed (GM2-9).
- **"committed, not shown"**: the change landed and the process died before the page could show anything.
- **"COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD"**: the same, and the recovery code the user had saved no longer
  opens the vault (GM2-1).

**Hard invariants, asserted at every point and holding at all 356:**
- every account is there (for `purgeForever`, before or after the purge; for `startOver`, the empty vault);
- some credential the user holds opens what `load()` sees;
- a completed run's new code and password open it;
- after `selfCheck`, the pointer slot, `sk_keyring` and `sk_mirror_gen` carry one keyring (172 of 172 restart points);
- old material in this store means a "full" cleanup is due, and old material anywhere means some cleanup is due;
- no device material remains after the popup's cleanup when the vault is password-protected.

| Operation | Writes / commits at | Crash points | Outcome counts (each point × restart and no restart) | Never-shown commits at (write, mode) | Other slot differs after the next open/unlock at |
|---|---|---|---|---|---|
| enableMasterPassword | 20 / 3 | 82 | 10 rolled back / unchanged; 70 committed, not shown; 2 completed | — | 2: 2a, 3b |
| rotateKey | 20 / 3 | 82 | 10 rolled back / unchanged; 70 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 35: 3a, 4a, 4b, 5a, 5b, 6a, 6b, 7a, 7b, 8a, 8b, 9a, 9b, 10a, 10b, 11a, 11b, 12a, 12b, 13a, 13b, 14a, 14b, 15a, 15b, 16a, 16b, 17a, 17b, 18a, 18b, 19a, 19b, 20a, 20b | — |
| changePassword | 5 / 2 | 22 | 6 rolled back / unchanged; 14 committed, not shown; 2 completed | — | 10: 1a, 2a, 2b, 3a, 3b, 4a, 4b, 5a, 5b, 6b |
| resetPasswordWithRecovery | 5 / 2 | 22 | 6 rolled back / unchanged; 14 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 7: 2a, 3a, 3b, 4a, 4b, 5a, 5b | 10: 1a, 2a, 2b, 3a, 3b, 4a, 4b, 5a, 5b, 6b |
| newRecoveryCode | 4 / 2 | 18 | 6 rolled back / unchanged; 10 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 5: 2a, 3a, 3b, 4a, 4b | 8: 1a, 2a, 2b, 3a, 3b, 4a, 4b, 5b |
| purgeForever | 17 / 2 | 70 | 68 rolled back / unchanged; 2 completed | — | — |
| restoreBackup (over lost) | 7 / 3 | 30 | 6 no active generation (lost); 22 landed (code confirmed before); 2 completed | — | — |
| startOver (over lost) | 7 / 3 | 30 | 6 no active generation (lost); 22 landed (code confirmed before); 2 completed | — | — |

**"Other slot differs"** is the same-VK leftover. For `changePassword`, `resetPasswordWithRecovery` and
`newRecoveryCode` it is either the rejected new keyring (FIXa2, the points before the commit) or the superseded old one
(P-5, the points after the commit, completed runs included): GM2-2 and GM2-3. For `enableMasterPassword` it is a device
vault after a rollback, which never runs the cleanup on open.

## Appendix B: probe source (`extension/test/regression/gm2-review.test.ts`, scratch only)

Run: `npx vitest run test/regression/gm2-review.test.ts`. 19 tests; all pass on the merged tree, which means each REPRO
reproduces and each SOUND holds.

```ts
// G-M2 combined review probes (docs/audit/internal-reviews/GM2-REVIEW.md). Each "REPRO" passes when the problem it names is present; each
// "SOUND" passes when the property holds. Scratch copy only.
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, unwrapPreviousVks } from "../../src/core/crypto/keyring";
import { decryptVault, encryptVault } from "../../src/core/crypto/envelope";
import { fromB64 } from "../../src/core/crypto/bytes";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { checkGeneration, checkKeyringCopy, checkSnapshot, KEYS, parseSnapshotIndex, type Generation } from "../../src/core/storage/format";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { deserializeVault } from "../../src/core/vault/validate";
import { createProtected, legacyDeviceVault, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6 as const, period: 30 });

function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const diag: string[] = [];
  const store = (k: KV = kv, m: KV = mirror) => new VaultStore({ kv: k, mirror: m, now: () => t.now, onDiag: (s) => diag.push(s) });
  const svc = (k: KV = kv, m: KV = mirror, s: SessionCache = session) => new VaultService({ store: store(k, m), session: s, settings, now: () => t.now, onDiag: (x) => diag.push(x) });
  const add = async (s: VaultService, n: string) => { t.now += 60_000; await s.mutate((v, c) => addEntry(v, input(n), c).vault); };
  return { kv, mirror, session, t, settings, store, svc, add, diag };
}
type W = ReturnType<typeof world>;

const wrap = (inner: KV, o: Partial<KV>): KV => ({ get: (k) => inner.get(k), keys: () => inner.keys(), set: (i) => inner.set(i), remove: (k) => inner.remove(k), ...o });
const failNthRead = (inner: KV, key: string, n: number): KV => { let c = 0; return wrap(inner, { get: async (k) => { if (k.includes(key) && ++c === n) throw new Error("IO error: transient"); return inner.get(k); } }); };
const ptrOf = (w: W) => w.kv.data.get(KEYS.active) as "a" | "b";
const otherOf = (s: "a" | "b") => (s === "a" ? "b" : "a");
const active = async (w: W) => (await checkGeneration(w.kv.data.get(KEYS.slot[ptrOf(w)])))!;
const otherSlot = async (w: W) => checkGeneration(w.kv.data.get(KEYS.slot[otherOf(ptrOf(w))]));
const losePointerWrite = (w: W) => w.kv.data.set(KEYS.active, otherOf(ptrOf(w)));
const namesOf = async (w: W, s?: VaultService) => aliveEntries((await (s ?? w.svc()).read()).vault).map((e) => e.issuer);
const opensWithCode = async (g: Generation, code: string) => unlockWithRecoveryCode(g.keyring, code).then(() => true, () => false);

class Dead extends Error {}
const dying = (at: (items: Record<string, unknown>) => boolean) => {
  let dead = false;
  return (inner: KV): KV => ({
    get: async (k) => { if (dead) throw new Dead(); return inner.get(k); },
    keys: async () => { if (dead) throw new Dead(); return inner.keys(); },
    set: async (i) => { if (dead) throw new Dead(); if (at(i)) { dead = true; throw new Dead(); } return inner.set(i); },
    remove: async (k) => { if (dead) throw new Dead(); return inner.remove(k); },
  });
};
const atCommit = (i: Record<string, unknown>) => KEYS.active in i;

/** Pointer slot, keyring copy and mirror generation all carry the same keyring. */
async function tripleConsistent(w: W): Promise<string[]> {
  const g = await active(w);
  const out: string[] = [];
  const c = checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy));
  if (!c || canonicalJson(c.keyring) !== canonicalJson(g.keyring)) out.push("keyring copy differs from the pointer slot");
  const m = await checkGeneration(w.mirror.data.get(KEYS.mirrorGen));
  if (!m || canonicalJson(m.keyring) !== canonicalJson(g.keyring)) out.push("mirror generation differs from the pointer slot");
  return out;
}

// ---- Q1(c): FIXa2 against ordinary saves after a key change ---------------------------------------------------------------

describe("Q1(c) SOUND: after a key change, ordinary saves, then a lost pointer write: nothing the user saw saved is lost", () => {
  for (const loseAfter of [1, 2]) {
    it(`rotation whose cleanup failed, ${loseAfter} save(s), the last save's pointer write lost`, async () => {
      const w = world();
      await createProtected(w.svc());
      await w.add(w.svc(), "GitHub");
      const oldSlot = KEYS.slot[ptrOf(w)];
      await w.svc(failNthRead(w.kv, oldSlot, 2)).rotateKey(STRONG); // the cleanup fails: the old slot keeps K1
      expect((await checkGeneration(w.kv.data.get(oldSlot)))!.keyring.vkId).not.toBe((await active(w)).keyring.vkId);
      const names = ["GitHub"];
      for (const n of ["AWS", "Stripe"].slice(0, loseAfter)) { await w.add(w.svc(), n); names.push(n); }
      losePointerWrite(w);
      await w.store().selfCheck();
      expect(await namesOf(w)).toEqual(names);
      expect(await tripleConsistent(w)).toEqual([]);
    });
  }
  it("a lying disk that drops only the key change's pointer write (later writes land): the session no longer matches, no save can land under the dropped key, nothing is lost", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    let dropped = false;
    const lying = wrap(w.kv, { set: async (i) => { if (!dropped && KEYS.active in i && Object.keys(i).length === 1 && w.kv.data.has(KEYS.keyChange)) { dropped = true; return; } return w.kv.set(i); } });
    const { recoveryCode: r2 } = await w.svc(lying).rotateKey(STRONG); // "success": the code is shown
    expect(dropped).toBe(true);
    expect(await tripleConsistent(w)).not.toEqual([]); // before the self-check the triple is out of step
    await expect(w.add(w.svc(), "AWS")).rejects.toMatchObject({ code: "locked" }); // the K2 session does not match K1
    await w.store().selfCheck();
    expect(await tripleConsistent(w)).toEqual([]);
    expect(await opensWithCode(await active(w), r1)).toBe(true);
    expect(await opensWithCode(await active(w), r2)).toBe(false); // the shown code is dead (FIXa2's accepted cost)
    await w.svc().unlockWithPassword(STRONG);
    expect(await namesOf(w)).toEqual(["GitHub"]);
  });
});

// ---- Q1: what FIXa2 leaves behind --------------------------------------------------------------------------------------

describe("Q1 REPRO: FIXa2 leaves the rejected keyring in the other slot (same-VK changes: no marker, nothing removes it)", () => {
  it("newRecoveryCode dies at the commit: after selfCheck and an unlock the unseen code still sits in the other slot; damage the pointer slot and that code becomes the only recovery code", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const die = dying(atCommit);
    await expect(w.svc(die(w.kv), die(w.mirror)).newRecoveryCode()).rejects.toBeInstanceOf(Dead);
    await w.store().selfCheck();
    expect(await opensWithCode(await active(w), r1)).toBe(true); // FIXa2: rolled back
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // same VK: no marker
    await w.svc().lock();
    await w.svc().unlockWithRecoveryCode(r1);
    await w.svc().openView();
    const y = await otherSlot(w);
    expect(canonicalJson(y!.keyring)).not.toBe(canonicalJson((await active(w)).keyring)); // still the rejected keyring
    expect(y!.seq).toBeGreaterThan((await active(w)).seq);
    // a second, unrelated fault: the pointer slot is damaged
    w.kv.data.set(KEYS.slot[ptrOf(w)], { torn: "x" });
    await w.store().selfCheck();
    expect(await opensWithCode(await active(w), r1)).toBe(false); // the saved code no longer opens
    // (the unseen code from the dead process is now the only recovery wrap; the password still works)
    await expect(unlockWithPassword((await active(w)).keyring, STRONG)).resolves.toBeDefined();
  });

  it("FIXa2 rolls a change back silently: no StorageEvent is recorded for the user", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    await w.svc().resetPasswordWithRecovery(r1, STRONG2); // shown: success
    losePointerWrite(w);
    const r = await w.store().selfCheck();
    expect(r.status === "ok" && r.events).toEqual([]);
    expect(await w.store().listEvents()).toEqual([]);
    await expect(unlockWithPassword((await active(w)).keyring, STRONG2)).rejects.toThrow(); // the password the user just set is dead, no notice
  });
});

// ---- Q1(b): the commit lands, the code is never shown ------------------------------------------------------------------

/** A session whose writes fail (chrome.storage.session or the settings read in RoutedSession throwing once). */
class FailingSet extends MemorySession {
  fail = false;
  override async set(d: SessionData) { if (this.fail) { this.fail = false; throw new Error("session write failed"); } return super.set(d); }
}

describe("Q1(b) REPRO: a key change that committed is reported as failed when startSession throws afterwards; the new code is never returned", () => {
  it("rotateKey", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const s = new FailingSet();
    s.data = w.session.data; s.epoch = w.session.epoch;
    s.fail = true;
    await expect(w.svc(w.kv, w.mirror, s).rotateKey(STRONG)).rejects.toThrow("session write failed");
    await w.store().selfCheck();
    expect(await opensWithCode(await active(w), r1)).toBe(false); // the saved code is dead, the new one was never shown
  });
  it("enableMasterPassword: the vault is password-protected with a recovery code nobody saw", async () => {
    const w = world();
    await legacyDeviceVault(w.store());
    await w.add(w.svc(), "GitHub");
    const s = new FailingSet();
    s.fail = true;
    await expect(w.svc(w.kv, w.mirror, s).enableMasterPassword(STRONG)).rejects.toThrow("session write failed");
    expect((await active(w)).keyring.deviceKey).toBeUndefined();
    expect((await active(w)).keyring.wraps.map((x) => x.method).sort()).toEqual(["password", "recovery"]);
  });
  it("resetPasswordWithRecovery (popup): the code just used is dead and the new one was never shown", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.svc().lock();
    const s = new FailingSet();
    s.fail = true;
    await expect(w.svc(w.kv, w.mirror, s).resetPasswordWithRecovery(r1, STRONG2)).rejects.toThrow("session write failed");
    expect(await opensWithCode(await active(w), r1)).toBe(false);
    await expect(w.svc().resetPasswordWithRecovery(r1, STRONG2)).rejects.toMatchObject({ code: "wrong_secret" }); // a retry is refused
  });
});

// ---- P-5 and the M2 hook -----------------------------------------------------------------------------------------------

describe("P-5 / M2 REPRO: same-VK keyring changes", () => {
  it("after changePassword the old password opens the other slot's keyring and that VK decrypts the current data", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().changePassword(STRONG, STRONG2);
    const y = (await otherSlot(w))!;
    const vk = await unlockWithPassword(y.keyring, STRONG);
    const cur = await active(w);
    expect(aliveEntries(deserializeVault(await decryptVault(cur.envelope, vk))).map((e) => e.issuer)).toEqual(["GitHub"]);
  });
  it("transact({ keyChange: true }) does not help: the cleanup compares vkIds only, so the old wrap stays in the other slot after finishKeyChange", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk = await vkFromRaw(fromB64(w.session.data!.vk));
    const { changePassword } = await import("../../src/core/crypto/keyring");
    // what an M2 same-VK adoption of a remote password change would do, through the documented hook
    await w.store().transact(async (cur) => ({ envelope: cur!.envelope, keyring: await changePassword(cur!.keyring, vk, STRONG2) }), { keyChange: true });
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    const r = await w.store().finishKeyChange(vk, async () => null);
    expect(r.done).toBe(true);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    const y = (await otherSlot(w))!;
    await expect(unlockWithPassword(y.keyring, STRONG)).resolves.toBeDefined(); // the old password still unwraps the VK
  });
});

// ---- M2 hand-off: SYNC-DESIGN §0.0h requirement 4 ------------------------------------------------------------------------

describe("M2 REPRO: finishKeyChange never offers a snapshot under a key outside keyring.previous to the re-encrypt callback", () => {
  it("a snapshot under a VK the new keyring does not list (the §3.5 join case) is kept, and the callback is never called for it", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub"); // r-snapshots under K1
    const vk1 = await vkFromRaw(fromB64(w.session.data!.vk));
    // adopt a keyring for a new VK that does not list K1 (what §3.5 / §3.3 / cloud restore do), through transact
    const other = world();
    await createProtected(other.svc());
    const g2 = await active(other);
    const vk2 = await vkFromRaw(fromB64(other.session.data!.vk));
    const plain = await decryptVault((await active(w)).envelope, vk1);
    const env = await encryptVault(plain, vk2, { vaultId: g2.keyring.vaultId, rev: 1 });
    await w.store().transact(async () => ({ envelope: env, keyring: g2.keyring }), { keyChange: true });
    let offered = 0;
    const r = await w.store().finishKeyChange(vk2, async (e) => { if (e.vkId === vk1.id) offered++; return null; });
    expect(offered).toBe(0);
    expect(r.kept).toBeGreaterThan(0);
    const k1Snaps = [...w.kv.data.entries()].filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);
    const under = await Promise.all(k1Snaps.map(async ([, v]) => (await checkSnapshot(v))?.envelope.vkId));
    expect(under).toContain(vk1.id);
    expect(r.done).toBe(true); // and the marker is gone: nothing will ever look at them again
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- P-9 ----------------------------------------------------------------------------------------------------------------

describe("P-9 REPRO: a fresh install whose IndexedDB mirror always throws can never get a vault", () => {
  it("openView throws instead of 'empty', and create() fails before writing", async () => {
    const w = world();
    const broken: KV = { get: async () => { throw new Error("Internal error opening backing store"); }, set: async () => { throw new Error("idb"); }, remove: async () => { throw new Error("idb"); }, keys: async () => { throw new Error("idb"); } };
    const svc = w.svc(w.kv, broken);
    await expect(svc.openView()).rejects.toThrow("backing store");
    const keys = await svc.prepareKeys(STRONG);
    await expect(svc.create(keys)).rejects.toThrow("backing store");
    expect([...w.kv.data.keys()].filter((k) => k.startsWith("sk_slot"))).toEqual([]);
  });
});

// ---- A2-4: keep-and-report after restoring over a lost device-key vault ------------------------------------------------

describe("A2-4: snapshots of a lost device-key vault after restoreBackup / startOver", () => {
  it("startOver keeps the old device-key snapshots (decryptable by whoever still has that device key) until they age out", async () => {
    const w = world();
    const { vk: oldVk } = await legacyDeviceVault(w.store());
    await w.add(w.svc(), "GitHub");
    await w.add(w.svc(), "AWS");
    // both slots, the keyring copy and the mirror generation are damaged: "lost"
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
    w.mirror.data.delete(KEYS.mirrorGen);
    const svc = w.svc();
    expect((await svc.openView()).state).toBe("lost");
    await svc.startOver(await svc.prepareKeys(STRONG));
    await svc.openView(); // the cleanup the marker asks for
    const recs = [...w.kv.data.entries()].filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);
    const old = [];
    for (const [, v] of recs) { const r = await checkSnapshot(v); if (r && r.envelope.vkId === oldVk.id) old.push(r); }
    expect(old.length).toBeGreaterThan(0);
    // anyone holding the old device key (LevelDB residue, a profile copy taken earlier) opens them without any password
    const opened = await Promise.all(old.map(async (r) => aliveEntries(deserializeVault(await decryptVault(r.envelope, oldVk))).map((e) => e.issuer)));
    expect(opened).toContainEqual(["GitHub", "AWS"]);
    // they age out: 10 more saves push the rolling ones out
    for (let i = 0; i < 10; i++) await w.add(w.svc(), `n${i}`);
    const left = [];
    for (const [k, v] of w.kv.data) if (k.startsWith("sk_snap_r")) { const r = await checkSnapshot(v); if (r?.envelope.vkId === oldVk.id) left.push(k); }
    expect(left).toEqual([]);
  });
});

// ---- A2-9: touch() ------------------------------------------------------------------------------------------------------

describe("A2-9: reads made by touch() through the real router", () => {
  it("counts", async () => {
    const { RoutedSession } = await import("../../src/platform/session");
    const kv = new MemoryKV();
    let reads = 0;
    const counting = wrap(kv, { get: async (k) => { reads++; return kv.get(k); } });
    const settings = new KvSettingsStore(counting);
    const persistent = new MemorySession();
    persistent.data = { vk: "x", lastActive: 1, epoch: 0 };
    const svc = new VaultService({ store: new VaultStore({ kv: counting }), session: new RoutedSession(persistent, settings), settings });
    await svc.touch();
    expect(reads).toBe(2);
  });
});

// ---- Q2: openVault's decrypt fallback and reads that throw -------------------------------------------------------------

describe("Q2 REPRO: the decrypt fallback skips a snapshot whose read throws and restores an older one", () => {
  it("active copy passes its checksum but does not open, the other slot is torn, no mirror gen, the newest snapshot's read throws once: an older snapshot is committed", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const vk = await vkFromRaw(fromB64(w.session.data!.vk));
    const act = await active(w);
    const { utf8 } = await import("../../src/core/crypto/bytes");
    w.kv.data.set(KEYS.slot[ptrOf(w)], { ...act, envelope: await encryptVault(utf8("not a vault"), vk, { vaultId: act.keyring.vaultId, rev: act.envelope.rev + 1 }) });
    w.kv.data.set(KEYS.slot[otherOf(ptrOf(w))], { torn: "x" });
    w.mirror.data.delete(KEYS.mirrorGen); // the mirror has nothing newer (e.g. IndexedDB failing writes)
    const newest = KEYS.snap(`r${act.seq}`);
    expect(w.kv.data.has(newest)).toBe(true);
    let thrown = 0;
    const flaky = wrap(w.kv, { get: async (k) => { if (k.length === 1 && k[0] === newest && thrown === 0) { thrown++; throw new Error("IO error: transient"); } return w.kv.get(k); } });
    const v = await w.svc(flaky).openView();
    expect(thrown).toBe(1);
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]); // "Stripe" is not in what was restored
    expect(v.state === "unlocked" && v.events.map((e) => e.kind)).toEqual(["decrypt_fallback"]);
  });
});

// ---- Q2: session writes are not under any lock ---------------------------------------------------------------------------

describe("Q2 REPRO: touch() racing lock() in another context puts the key back into shared session storage", () => {
  it("the key stays in storage.session after the lock (void by epoch, but present until the next check)", async () => {
    const { RoutedSession } = await import("../../src/platform/session");
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const shared = new MemorySession(); // chrome.storage.session, shared by every context
    let gate: (() => void) | null = null;
    const slowGet: SessionCache = {
      get: async () => { const d = await shared.get(); if (gate === null) await new Promise<void>((r) => { gate = r; }); return d; },
      set: (d) => shared.set(d), clear: () => shared.clear(), lockEpoch: () => shared.lockEpoch(), bumpLockEpoch: () => shared.bumpLockEpoch(),
    };
    shared.data = { vk: "AAAA", lastActive: 1, epoch: 0 };
    const popup = new VaultService({ store: new VaultStore({ kv }), session: new RoutedSession(slowGet, settings), settings });
    const sw = new VaultService({ store: new VaultStore({ kv }), session: new RoutedSession(shared, settings), settings });
    const touching = popup.touch(); // reads the session, then waits
    while (gate === null) await new Promise((r) => setTimeout(r, 1));
    await sw.lock(); // screen lock: cleared, epoch bumped
    expect(shared.data).toBeNull();
    (gate as () => void)();
    await touching;
    expect(shared.data).not.toBeNull(); // the raw key is back in storage.session
    expect(shared.data!.epoch).toBe(0);
    expect(await shared.lockEpoch()).toBe(1);
  });
});

// ---- Q2: a mirror generation newer than both slots ------------------------------------------------------------------------

describe("Q2 REPRO: selfCheck overwrites a mirror generation that is newer than the slots", () => {
  it("chrome.storage.local loses the tail of its log (power loss), IndexedDB kept the last save: the self-check throws that save away", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const before = new Map([...w.kv.data].map(([k, v]) => [k, structuredClone(v)]));
    await w.add(w.svc(), "AWS"); // seen saved
    expect((await checkGeneration(w.mirror.data.get(KEYS.mirrorGen)))!.seq).toBe((await active(w)).seq);
    // the local store comes back as it was before the last save; the mirror kept it
    w.kv.data.clear();
    for (const [k, v] of before) w.kv.data.set(k, v);
    const mirrorSeq = (await checkGeneration(w.mirror.data.get(KEYS.mirrorGen)))!.seq;
    expect(mirrorSeq).toBeGreaterThan((await active(w)).seq);
    await w.store().selfCheck();
    expect(await namesOf(w)).toEqual(["GitHub"]);
    expect((await checkGeneration(w.mirror.data.get(KEYS.mirrorGen)))!.seq).toBeLessThan(mirrorSeq); // overwritten, AWS gone everywhere
  });
});

// ---- FIXb for same-VK keyring changes (mutant B3 survives the package's tests) ------------------------------------------

describe("SOUND (pins FIXb for same-VK changes): a reset whose pointer write lands and still reports an error", () => {
  it("leaves the old password and recovery code working, and a retry with the same code works", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    let done = false;
    const landsThenThrows = wrap(w.kv, { set: async (i) => { await w.kv.set(i); if (!done && KEYS.active in i) { done = true; throw new Error("IO error after the write"); } } });
    await expect(w.svc(landsThenThrows).resetPasswordWithRecovery(r1, STRONG2)).rejects.toThrow("IO error after the write");
    await w.store().selfCheck();
    expect(await opensWithCode(await active(w), r1)).toBe(true);
    await expect(w.svc().resetPasswordWithRecovery(r1, STRONG2)).resolves.toMatchObject({ recoveryCode: expect.any(String) });
  });
});

// ---- purgeForever interrupted ----------------------------------------------------------------------------------------------

describe("REPRO: purgeForever interrupted after its edit committed leaves the purged secret in live copies, and nothing retries", () => {
  it("the process dies at the first write of the rewrite: the other slot and the snapshots still hold the secret after a restart and an unlock", async () => {
    const w = world();
    await createProtected(w.svc());
    const SECRET = "GEZDGNBVGY3TQOJQ";
    w.t.now += 60_000;
    await w.svc().mutate((v, c) => addEntry(v, { ...input("Bank"), secret: SECRET }, c).vault);
    await w.add(w.svc(), "GitHub");
    const id = (await w.svc().read()).vault.entries.find((e) => e.issuer === "Bank")!.id;
    let writes = 0;
    let dead = false;
    const proc = (inner: KV): KV => wrap(inner, {
      get: async (k) => { if (dead) throw new Dead(); return inner.get(k); },
      keys: async () => { if (dead) throw new Dead(); return inner.keys(); },
      // the edit's transact: slot, pointer, snapshot, keyring copy, mirror = 5 writes; die at the 6th (the rewrite's first)
      set: async (i) => { if (dead) throw new Dead(); if (++writes === 6) { dead = true; throw new Dead(); } return inner.set(i); },
      remove: async (k) => { if (dead) throw new Dead(); return inner.remove(k); },
    });
    await expect(w.svc(proc(w.kv), proc(w.mirror)).purgeForever([id])).rejects.toBeInstanceOf(Dead);
    await w.store().selfCheck();
    w.session.data = null;
    await w.svc().unlockWithPassword(STRONG);
    await w.svc().openView();
    const vk = await vkFromRaw(fromB64(w.session.data!.vk));
    const holding: string[] = [];
    for (const [k, v] of w.kv.data) {
      const env = k === KEYS.slot.a || k === KEYS.slot.b ? (await checkGeneration(v))?.envelope : k.startsWith("sk_snap_") && k !== KEYS.snapIndex ? (await checkSnapshot(v))?.envelope : undefined;
      if (!env) continue;
      const plain = new TextDecoder().decode(await decryptVault(env, vk));
      if (plain.includes(SECRET)) holding.push(k);
    }
    expect((await namesOf(w))).toEqual(["GitHub"]); // the UI shows it erased
    expect(holding.length).toBeGreaterThan(0); // but live copies still hold it
  });
});
```

## Appendix C: crash-matrix source (`extension/test/regression/gm2-crash-matrix.test.ts`, scratch only)

Run: `GM2_MATRIX_OUT=../matrix.json npx vitest run test/regression/gm2-crash-matrix.test.ts` (about 57 s). It writes
one JSON row per crash point.

```ts
// G-M2 review crash matrix (docs/audit/internal-reviews/GM2-REVIEW.md, appendix). One process for local storage, the mirror and the session
// (the Proc model of test/fault/keychange-marker.test.ts) dies at write N of an operation, just before or just after the
// write lands. Then either the browser restarts (session cleared, selfCheck) or it does not (a page died; the popup opens).
// Hard invariants (fail the test): every account is there; some credential the user holds opens the vault; after
// selfCheck the pointer slot, the keyring copy and the mirror generation carry one keyring; the marker promise holds
// (old material in this store => a full cleanup is due). Classified, not failed: "committed but never shown" (the change
// landed, the process died before the page could show its result), and "rejected keyring left in the other slot".
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { checkGeneration, checkKeyringCopy, checkSnapshot, KEYS, parseSnapshotIndex, type Generation } from "../../src/core/storage/format";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { createProtected, deviceMaterial, legacyDeviceVault, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({ type: "totp" as const, issuer, label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6 as const, period: 30 });
const NAMES = ["GitHub", "AWS", "Stripe"];

class Dead extends Error { constructor() { super("process died"); this.name = "Dead"; } }
class Proc {
  calls = 0;
  dead = false;
  commits: number[] = [];
  constructor(public at = Infinity, public mode: "before" | "after" = "before") {}
  hit(items?: Record<string, unknown>): boolean {
    if (this.dead) throw new Dead();
    this.calls++;
    if (items && KEYS.active in items) this.commits.push(this.calls);
    if (this.calls === this.at) { this.dead = true; return this.mode === "after"; }
    return true;
  }
}
class ProcKV implements KV {
  constructor(private inner: MemoryKV, private p: Proc) {}
  async get(k: string[]) { if (this.p.dead) throw new Dead(); return this.inner.get(k); }
  async keys() { if (this.p.dead) throw new Dead(); return this.inner.keys(); }
  async set(items: Record<string, unknown>) { const land = this.p.hit(items); if (land) await this.inner.set(items); if (this.p.dead) throw new Dead(); }
  async remove(keys: string[]) { const land = this.p.hit(); if (land) await this.inner.remove(keys); if (this.p.dead) throw new Dead(); }
}
class ProcSession implements SessionCache {
  constructor(private inner: MemorySession, private p: Proc) {}
  async get() { if (this.p.dead) throw new Dead(); return this.inner.get(); }
  async set(d: SessionData) { const land = this.p.hit(); if (land) await this.inner.set(d); if (this.p.dead) throw new Dead(); }
  async clear() { const land = this.p.hit(); if (land) await this.inner.clear(); if (this.p.dead) throw new Dead(); }
  async lockEpoch() { return this.inner.lockEpoch(); }
  async bumpLockEpoch() { return this.inner.bumpLockEpoch(); }
}

const t = { now: 1_700_000_000_000 };
type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession };
const svcOver = (w: World, kv: KV = w.kv, mirror: KV = w.mirror, session: SessionCache = w.session) =>
  new VaultService({ store: new VaultStore({ kv, mirror, now: () => t.now }), session, settings: new KvSettingsStore(w.kv), now: () => t.now });
const clone = (w: World): World => {
  const c = (m: MemoryKV) => { const n = new MemoryKV(); for (const [k, v] of m.data) n.data.set(k, structuredClone(v)); return n; };
  const session = new MemorySession();
  session.data = w.session.data ? { ...w.session.data } : null;
  session.epoch = w.session.epoch;
  return { kv: c(w.kv), mirror: c(w.mirror), session };
};
async function daily(w: World, day: string) {
  await new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now, dayKey: () => day }).ensureDailySnapshot();
}

type Base = { w: World; r1: string | null; pw: string | null; vault: Vault | null; keyring: Keyring | null; lost: boolean };
async function protectedBase(): Promise<Base> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  const svc = svcOver(w);
  const { recoveryCode } = await createProtected(svc);
  for (const n of NAMES) { t.now += 60_000; await svc.mutate((v, c) => addEntry(v, input(n), c).vault); }
  await daily(w, "2026-01-01");
  await svc.openView(); // the one-time check
  const g = (await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"])))!;
  return { w, r1: recoveryCode, pw: STRONG, vault: (await svc.read()).vault, keyring: g.keyring, lost: false };
}
async function legacyBase(): Promise<Base> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  await legacyDeviceVault(new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now }));
  const svc = svcOver(w);
  for (const n of NAMES) { t.now += 60_000; await svc.mutate((v, c) => addEntry(v, input(n), c).vault); }
  await daily(w, "2026-01-01");
  const g = (await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"])))!;
  return { w, r1: null, pw: null, vault: (await svc.read()).vault, keyring: g.keyring, lost: false };
}
async function lostBase(): Promise<Base> {
  const b = await protectedBase();
  for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) b.w.kv.data.set(k, { torn: "x" });
  b.w.mirror.data.delete(KEYS.mirrorGen);
  b.w.session.data = null;
  expect((await svcOver(b.w).openView()).state).toBe("lost");
  return { ...b, lost: true };
}

type Op = {
  name: string;
  base: () => Promise<Base>;
  /** prepare outside the crashing process (no writes), e.g. keys for a restore */
  prep?: (b: Base, svc: VaultService) => Promise<unknown>;
  run: (svc: VaultService, b: Base, prep: unknown) => Promise<{ code?: string; pw?: string }>;
  /** what the user types during the operation (known whether or not it finished) */
  typed: string | null;
  /** names expected after a completed run */
  names: string[];
  lockFirst?: boolean;
};
const OPS: Op[] = [
  { name: "enableMasterPassword", base: legacyBase, run: async (s) => ({ code: (await s.enableMasterPassword(STRONG)).recoveryCode, pw: STRONG }), typed: STRONG, names: NAMES },
  { name: "rotateKey", base: protectedBase, run: async (s) => ({ code: (await s.rotateKey(STRONG)).recoveryCode, pw: STRONG }), typed: STRONG, names: NAMES },
  { name: "changePassword", base: protectedBase, run: async (s) => { await s.changePassword(STRONG, STRONG2); return { pw: STRONG2 }; }, typed: STRONG2, names: NAMES },
  { name: "resetPasswordWithRecovery", base: protectedBase, lockFirst: true, run: async (s, b) => ({ code: (await s.resetPasswordWithRecovery(b.r1!, STRONG2)).recoveryCode, pw: STRONG2 }), typed: STRONG2, names: NAMES },
  { name: "newRecoveryCode", base: protectedBase, run: async (s) => ({ code: (await s.newRecoveryCode()).recoveryCode }), typed: null, names: NAMES },
  {
    name: "purgeForever", base: protectedBase,
    run: async (s, b) => { await s.purgeForever([b.vault!.entries.find((e) => e.issuer === "AWS")!.id]); return {}; }, typed: null, names: ["GitHub", "Stripe"],
  },
  {
    name: "restoreBackup (over lost)", base: lostBase,
    prep: async (b, s) => s.prepareKeys(STRONG2, { vaultId: b.vault!.vaultId }),
    run: async (s, b, keys) => { await s.restoreBackup(b.vault!, keys as never); return { code: (keys as { recoveryCode: string }).recoveryCode, pw: STRONG2 }; }, typed: STRONG2, names: NAMES,
  },
  {
    name: "startOver (over lost)", base: lostBase,
    prep: async (_b, s) => s.prepareKeys(STRONG2),
    run: async (s, _b, keys) => { await s.startOver(keys as never); return { code: (keys as { recoveryCode: string }).recoveryCode, pw: STRONG2 }; }, typed: STRONG2, names: [],
  },
];

const pwMemo = new Map<string, boolean>();
async function opensWithPw(k: Keyring, pw: string): Promise<boolean> {
  const w = k.wraps.find((x) => x.method === "password");
  if (!w) return false;
  const key = canonicalJson(w) + pw;
  if (!pwMemo.has(key)) pwMemo.set(key, await unlockWithPassword(k, pw).then(() => true, () => false));
  return pwMemo.get(key)!;
}
const opensWithCode = (k: Keyring, c: string) => unlockWithRecoveryCode(k, c).then(() => true, () => false);

async function activeGen(kv: MemoryKV): Promise<Generation | null> {
  const p = kv.data.get(KEYS.active);
  return p === "a" || p === "b" ? checkGeneration(kv.data.get(KEYS.slot[p])) : null;
}

/** Old material on disk relative to the active generation (as keychange-marker.test's oldMaterial, compact). */
async function oldMaterial(w: World, g: Generation): Promise<string[]> {
  const out: string[] = [];
  const old = (k: Keyring) => k.vkId !== g.keyring.vkId || (k.deviceKey !== undefined && g.keyring.deviceKey === undefined);
  const prev = new Set(g.keyring.previous.map((p) => p.vkId));
  for (const [name, m] of [["local", w.kv], ["mirror", w.mirror]] as const) {
    for (const [k, v] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) { const x = await checkGeneration(v); if (x && old(x.keyring)) out.push(`${name}:${k}`); }
      else if (k === KEYS.keyringCopy) { const x = checkKeyringCopy(v); if (x && old(x.keyring)) out.push(`${name}:${k}`); }
      else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) { const r = await checkSnapshot(v); if (r && prev.has(r.envelope.vkId)) out.push(`${name}:${k}`); }
    }
  }
  if (!g.keyring.deviceKey) for (const [n, m] of [["local", w.kv], ["mirror", w.mirror]] as const) out.push(...deviceMaterial(m).map((x) => `${n}:${x}`));
  return out;
}

type Row = { op: string; at: number; mode: string; restart: boolean; died: boolean; outcome: string; opens: string[]; names: string; triple: string; marker: string; leftover: boolean };
const rows: Row[] = [];

describe.each(OPS.map((o) => [o.name, o] as const))("crash matrix: %s", (_n, op) => {
  it("every write, before and after it lands, with and without a browser restart", async () => {
    const base = await op.base();
    if (op.lockFirst) base.w.session.data = null;
    // count the writes of an uninterrupted run
    const count = clone(base.w);
    const pc = new Proc();
    const svcC = svcOver(count, new ProcKV(count.kv, pc), new ProcKV(count.mirror, pc), new ProcSession(count.session, pc));
    const prepC = op.prep ? await op.prep(base, svcOver(count)) : undefined;
    await op.run(svcC, base, prepC);
    const total = pc.calls;
    const commits = pc.commits;
    rows.push({ op: op.name, at: 0, mode: "count", restart: false, died: false, outcome: `writes=${total} commits@${commits.join(",")}`, opens: [], names: "", triple: "", marker: "", leftover: false });

    for (let at = 1; at <= total + 1; at++) {
      for (const mode of ["before", "after"] as const) {
        if (at === total + 1 && mode === "after") continue;
        for (const restart of [true, false]) {
          const w = clone(base.w);
          const p = new Proc(at, mode);
          const prep = op.prep ? await op.prep(base, svcOver(w)) : undefined;
          let result: { code?: string; pw?: string } | null = null;
          try {
            result = await op.run(svcOver(w, new ProcKV(w.kv, p), new ProcKV(w.mirror, p), new ProcSession(w.session, p)), base, prep);
          } catch (e) {
            if (!(e instanceof Dead)) throw e;
          }
          // A process that died did not show anything, even if guarded() let the function run on and return.
          const died = p.dead;
          if (died) result = null;
          if (restart) {
            w.session = new MemorySession();
            await new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now }).selfCheck();
          }
          const where = `${op.name} @${at} ${mode} restart=${restart}`;
          // what every load() sees (a broken pointer slot goes down the recovery ladder, as the popup's open does)
          const lr = await new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now }).load();
          const g = lr.status === "ok" ? lr.gen : null;
          // which credentials open what every load() sees
          const opens: string[] = [];
          let outcome: string;
          if (!g) {
            const st = (await svcOver(w).openView()).state;
            outcome = `no active generation (${st})`;
            if (op.name.includes("over lost")) expect(st, where).toBe("lost"); else throw new Error(`${where}: no vault`);
          } else {
            if (g.keyring.deviceKey) opens.push("device");
            if (base.pw && (await opensWithPw(g.keyring, base.pw))) opens.push("old pw");
            if (op.typed && op.typed !== base.pw && (await opensWithPw(g.keyring, op.typed))) opens.push("typed pw");
            if (base.r1 && !base.lost && (await opensWithCode(g.keyring, base.r1))) opens.push("old code");
            if (result?.code && (await opensWithCode(g.keyring, result.code))) opens.push("new code");
            // a key change that never returned but whose keyring is not the old one
            const same = base.keyring && canonicalJson(g.keyring) === canonicalJson(base.keyring);
            if (!died) outcome = "completed";
            else if (same || op.name === "purgeForever") outcome = "rolled back / unchanged";
            else if (base.lost) outcome = "landed (code confirmed before)";
            else outcome = base.r1 && !opens.includes("old code") ? "COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD" : "committed, not shown";
            if (!died && result?.code) expect(opens, `${where}: a completed run's code opens`).toContain("new code");
            if (!died && result?.pw) expect(opens.includes("old pw") || opens.includes("typed pw"), `${where}: a completed run's password opens`).toBe(true);
            expect(opens.length, `${where}: some credential the user holds opens`).toBeGreaterThan(0);
          }
          // the marker promise, before anything cleans up
          let marker = "-";
          if (g) {
            const left = await oldMaterial(w, g);
            const r = await new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now }).loadView();
            const due = r.status === "ok" ? r.cleanup : "n/a";
            marker = left.length ? `${left.length} old, cleanup ${due}` : `clean, cleanup ${due}`;
            if (left.some((x) => x.startsWith("local:"))) expect(due, `${where}: ${left.join(" ")}`).toBe("full");
            if (left.length) expect(due, `${where}: ${left.join(" ")}`).not.toBe("none");
          }
          // the triple, after a self-check
          let triple = "-";
          if (restart && g) {
            const c = checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy));
            const m = await checkGeneration(w.mirror.data.get(KEYS.mirrorGen));
            const ok = c && m && canonicalJson(c.keyring) === canonicalJson(g.keyring) && canonicalJson(m.keyring) === canonicalJson(g.keyring);
            triple = ok ? "ok" : "DIFFERS";
            expect(ok, `${where}: pointer slot / keyring copy / mirror`).toBe(true);
          }
          // every account, through whatever the user can open with; then the popup's cleanup runs
          let names = "";
          let leftover = false;
          if (g) {
            const s = svcOver(w);
            let v = await s.openView();
            if (v.state === "locked") {
              const pw = opens.includes("typed pw") ? op.typed! : base.pw!;
              v = (await s.unlockWithPassword(pw)).view;
            }
            if (v.state !== "unlocked") throw new Error(`${where}: ${v.state}`);
            names = aliveEntries(v.vault).map((e) => e.issuer).join(",");
            const expected = died && op.name === "purgeForever" ? null : died && outcome.startsWith("rolled") ? NAMES : op.names;
            if (expected) expect(names, where).toBe(expected.join(","));
            else expect([NAMES.join(","), op.names.join(",")], where).toContain(names);
            const g2 = (await activeGen(w.kv))!;
            const y = await checkGeneration(w.kv.data.get(KEYS.slot[(w.kv.data.get(KEYS.active) === "a" ? "b" : "a")]));
            leftover = !!y && canonicalJson(y.keyring) !== canonicalJson(g2.keyring);
            if (!g2.keyring.deviceKey) expect(deviceMaterial(w.kv, w.mirror), `${where}: device material after the cleanup`).toEqual([]);
          }
          rows.push({ op: op.name, at, mode, restart, died, outcome, opens, names, triple, marker, leftover });
        }
      }
    }
  }, 600_000);
});

describe("matrix summary", () => {
  it("writes the rows", () => {
    writeFileSync(process.env.GM2_MATRIX_OUT ?? "/dev/null", JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

## Appendix D: the proposed fixes, applied together in scratch (`gm2-fixroot/extension`)

The experiment covers:
- GM2-1(a): `startSession` after a committed key change is non-fatal;
- GM2-2(a): FIXa2 overwrites the rejected slot;
- GM2-3: a marker on any keyring change, `staleIn` comparing whole keyrings, and a cleanup after the three same-VK
  operations.

It does not include GM2-1(b), returning the code before the cleanup, so the never-shown window below grows for same-VK
operations by the cleanup's writes. GM2-1(b) is what removes that.

```diff
--- a/extension/src/core/storage/store.ts
+++ b/extension/src/core/storage/store.ts
@@ -197,13 +197,14 @@
       // user saw the change succeed, it is rolled back (the old password and recovery code open the vault again; no
       // account is lost, the data is the same). Ordinary saves (same keyring) keep "highest sequence wins".
       const named = ptr === "a" ? ga : ptr === "b" ? gb : null;
-      if (named && slot !== ptr && canonicalJson(named.keyring) !== canonicalJson(gen.keyring)) [slot, gen] = [ptr!, named];
+      let rejected = false;
+      if (named && slot !== ptr && canonicalJson(named.keyring) !== canonicalJson(gen.keyring)) { [slot, gen] = [ptr!, named]; rejected = true; }
       const pointerSlotBroken = ptr !== null && (ptr === "a" ? ga : gb) === null;
       if (ptr !== slot) await this.kv.set({ [KEYS.active]: slot });
       if (pointerSlotBroken) {
         events.push(await this.pushEvent("slot_fallback", gen.savedAt, `slot ${ptr} was damaged; using slot ${slot}`));
       }
-      await this.restoreRedundancy(slot, gen, slot === "a" ? gb : ga);
+      await this.restoreRedundancy(slot, gen, rejected ? null : slot === "a" ? gb : ga);
       await this.gcSnapshots();
       return { status: "ok", gen, events };
     }
@@ -426,7 +427,7 @@
 
       // The marker goes down before the commit, and a failure to write it fails the save (see the top of this file).
       const leavesOldMaterial = opts.keyChange === true || (prev
-        ? prev.keyring.vkId !== gen.keyring.vkId || (prev.keyring.deviceKey !== undefined && gen.keyring.deviceKey === undefined)
+        ? canonicalJson(prev.keyring) !== canonicalJson(gen.keyring)
         : cur.status === "lost");
       if (leavesOldMaterial) {
         const marker: KeyChangeMarker = { v: 1, vkId: gen.keyring.vkId, at: gen.savedAt };
@@ -595,7 +596,7 @@
   private async staleIn(kv: KV, gen: Generation, ptr: SlotName): Promise<{ stale: boolean; unknown: number }> {
     const stale = { stale: true, unknown: 0 };
     let unknown = 0;
-    const old = (k: Keyring) => k.vkId !== gen.keyring.vkId || (k.deviceKey !== undefined && gen.keyring.deviceKey === undefined);
+    const old = (k: Keyring) => canonicalJson(k) !== canonicalJson(gen.keyring);
     const previous = new Set(gen.keyring.previous.map((p) => p.vkId));
     const genKey = kv === this.kv ? KEYS.slot[other(ptr)] : KEYS.mirrorGen;
     const g = (await kv.get([genKey]))[genKey];
--- a/extension/src/core/service/service.ts
+++ b/extension/src/core/service/service.ts
@@ -428,7 +428,7 @@
       const envelope = await encryptVault(plain, newVk, { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 }, this.rng);
       return { envelope, keyring: r.keyring };
     });
-    await this.startSession(newVk);
+    await this.startSession(newVk).catch((e) => this.diag("session after a key change", e));
     await this.scrubQuietly(oldVk, newVk);
     return { recoveryCode };
   }
@@ -448,7 +448,7 @@
       recoveryCode = r.recoveryCode;
       return { envelope: await encryptVault(plain, newVk, { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 }, this.rng), keyring: r.keyring };
     });
-    await this.startSession(newVk);
+    await this.startSession(newVk).catch((e) => this.diag("session after a key change", e));
     await this.scrubQuietly(oldVk, newVk);
     return { recoveryCode };
   }
@@ -497,7 +497,8 @@
       vk = await this.unlockWith2(cur.keyring, oldPassword);
       return { envelope: cur.envelope, keyring: await changePasswordWrap(cur.keyring, vk, newPassword, this.ctx) };
     });
-    await this.startSession(vk);
+    await this.startSession(vk).catch((e) => this.diag("session after a key change", e));
+    await this.scrubQuietly(vk, vk); // P-5: the other slot, the keyring copy and the mirror still hold the old wrap
   }
 
   /** Forgot the password: the recovery code unlocks, a new password and a new recovery code replace the old ones. */
@@ -518,20 +519,23 @@
       recoveryCode = r.recoveryCode;
       return { envelope: cur.envelope, keyring: r.keyring };
     });
-    await this.startSession(vk);
+    await this.startSession(vk).catch((e) => this.diag("session after a key change", e));
+    await this.scrubQuietly(vk, vk);
     return { recoveryCode };
   }
 
   /** Issue a fresh recovery code (the old one stops working). Needs an unlocked vault. */
   async newRecoveryCode(): Promise<{ recoveryCode: string }> {
     let recoveryCode!: string;
+    let vk!: Vk;
     await this.store.transact(async (cur) => {
       if (!cur) throw new ServiceError("bad_state", "no vault");
-      const vk = await this.requireVk(cur.keyring);
+      vk = await this.requireVk(cur.keyring);
       const r = await setRecovery(cur.keyring, vk, this.ctx);
       recoveryCode = r.recoveryCode;
       return { envelope: cur.envelope, keyring: r.keyring };
     });
+    await this.scrubQuietly(vk, vk);
     return { recoveryCode };
   }
 
```

**Full vitest suite on the fix (M1 contract and sync files included)**: 958 tests; **948 passed, 1 skipped, 9 failed**.
All 9 failures are expected flips.
- **7 review probes** that demonstrated the fixed problems: Q1(b) ×3, P-5 ×2, the FIXa2 leftover, and the silent
  rollback, which no longer rolls back once the cleanup has made both slots agree.
- **2 package tests that pin the old rule:**
  - `keychange-marker.test.ts` "a transact that takes the device key away while keeping the key id writes it too" (its
    first step, adding a password wrap, now writes a marker);
  - `a2-review.test.ts` "the cost (owner's decision) …" (a reset whose cleanup has finished is no longer rolled back by
    a lost pointer write).

Every other test passes, including `test/fault/store.test.ts`, `open-view-diff`, `read-budget`, `enable-crash`,
`create-crash` and the crash matrix, whose hard invariants still hold at every point. The e2e suite was not run on the
experiment.

Crash matrix on the fix:

| Operation | Writes / commits at | Outcome counts | Other slot differs after the next open/unlock |
|---|---|---|---|
| enableMasterPassword | 20 / 3 | 10 rolled back / unchanged; 70 committed, not shown; 2 completed | 2 |
| rotateKey | 20 / 3 | 10 rolled back / unchanged; 70 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 0 |
| changePassword | 10 / 3 | 10 rolled back / unchanged; 30 committed, not shown; 2 completed | 0 |
| resetPasswordWithRecovery | 10 / 3 | 10 rolled back / unchanged; 30 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 0 |
| newRecoveryCode | 9 / 3 | 10 rolled back / unchanged; 26 COMMITTED, NEW CODE NEVER SHOWN, OLD CODE DEAD; 2 completed | 0 |
| purgeForever | 17 / 2 | 68 rolled back / unchanged; 2 completed | 0 |
| restoreBackup (over lost) | 7 / 3 | 6 no active generation (lost); 22 landed (code confirmed before); 2 completed | 0 |
| startOver (over lost) | 7 / 3 | 6 no active generation (lost); 22 landed (code confirmed before); 2 completed | 0 |

The 2 remaining `enableMasterPassword` points are the no-restart variants of the device-vault rollback: the heal runs in
`selfCheck`, and a device vault never runs the cleanup on open.
