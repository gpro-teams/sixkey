# A2 (U1b) review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading, repository paths updated to the current layout and absolute local paths
> shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Scope: `phase0x/A2/A2.patch` (17 files) against the current main tree. Review only: nothing in the
> main tree was changed except this file. Every experiment ran in a scratch copy:
> `scratchpad/a2-review/` (patched),
> `.../scratchpad/a2-base/` (unpatched, for comparison), `.../scratchpad/a2-mut/<id>/` (one mutant each), runner
> `.../scratchpad/a2-mut-run.py`, results in `.../scratchpad/a2-mut-all.log`.
> Reproductions and probes: `.../scratchpad/a2-review/extension/test/regression/a2-review.test.ts` (15 tests, all pass on
> the patched tree, which means every REPRO reproduces), plus `a2-death.test.ts` and `a2-newer.test.ts` in the same
> directory. Line numbers refer to the patched files.
> The main tree changed during the review: the integrator merged B3 (`Main.tsx`, `List.tsx`, `AddMenu.tsx`, `scan.ts`,
> `qr.ts`, new `AddConfirm.tsx` and `dedupe.ts`). `A2.patch` still applies cleanly to it (`patch --dry-run`, exit 0).
> On updated main + A2 (`.../scratchpad/a2-newmain/`): typecheck is clean, 881 unit tests pass (1 skipped), check-dist
> is OK, and the popup is 53.8 KB gz. `Main.tsx`'s `getSettings()` read (A2-2) is at line 65 there (line 53 before B3).
> e2e there: 64 passed and 1 failed. The failure was `import-lines.spec.ts:12`, where the code cell read as empty just
> after matching the code pattern. It is a flake: the spec passes 16/16 with `--repeat-each=8` on updated main both
> with and without A2, and A2 does not touch list rendering. The real-browser read counts are unchanged after B3: open
> 5 before the first code (7 in all), unlock 8 before the first code (10 in all).

## Verdict

**MERGE AFTER FIXES.** The marker protocol is sound. Nothing in this patch leaves old key material on disk without a
marker, and 30 of the 33 mutants are killed. The fixes needed before merge are small: A2-1 (a mirror that keeps
failing pins the marker, so every open does the full scan) and A2-6 (no test in the package pins the lock around the
cleanup). The worst problem found is older than A2 (P-1, High): a key change that the user was told had failed is
committed later by `selfCheck`. It does not block this merge. FIXb (6 lines) must land before A1/A2 ship to users, and
P-1 must be fully fixed before M2. Two fixes are proposed, and both pass the whole suite.

| Severity | Introduced or affected by A2 | Pre-existing | Total |
|---|---|---|---|
| High | 0 | 1 | 1 |
| Medium | 2 | 3 | 5 |
| Low | 4 | 3 | 7 |
| Info | 3 | 2 | 5 |

**Top 3**
1. **P-1 (High, pre-existing).** `rotateKey`, `resetPasswordWithRecovery` or `enableMasterPassword` fails at the
   commit, or the process dies there, and the user is told it failed. At the next browser start, `selfCheck` commits it
   anyway. The saved recovery code stops working and the new one was never shown. After a reset, neither the old
   password nor the saved code opens the vault, and retrying the reset is refused (reproduced). Fix: FIXb plus FIXa2
   below. Must be fixed before M2.
2. **A2-1 (Medium).** If IndexedDB stays broken (for example "Internal error opening backing store"), `finishKeyChange`
   can never finish. The marker, or the missing `sk_store_v`, then stays forever, and every unlocked popup open repeats
   the full scan: 21 reads instead of 4, one of them `get(null)`, which reads the whole store. For an existing user
   whose IndexedDB is already broken at upgrade, this starts on day one.
3. **A2-6 / A2-2 (test and gate gaps).** Removing the lock from `finishKeyChange` survives every test in the package; only
   this review's two-context probe kills it. The hard read gate measures `loadScreen` only. The real popup makes 5 reads
   before the first code (7 in all) when opening, and 8 (10 in all) when unlocking. The implementer's own `perf.spec`
   and bench measured these numbers, but only print them. The ux-study budget (≤ 4 / ≤ 8) was defined on the real popup.

## Verification (scratch copy, patched)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` | 49 files, **859 passed**, 1 skipped (matches the report) |
| `npm run build && npm run check` | check-dist OK; **popup 51.4 KB gz** (unpatched main builds to 50.4, so A2 adds **+1.0 KB**; the plan estimated +0.2) |
| `npm run build:e2e && npx playwright test` | **56 passed** (4.0 min) |
| `test/regression/enable-crash.test.ts`, `test/fault/store.test.ts` | byte-identical to main (`diff -q`), and both pass |
| read gate (unit, `loadScreen` over the real `createRuntime` wiring) | open: 4 reads, 1.0x the slot, 0 mirror reads (old path: 16 reads, 4–5x); lock screen + unlock: 7 reads, 2.0x; device-key vault: 3. The same with 2 and 17 snapshots, at 10, 100 and 500 accounts |
| real browser (A2 numbers from `perf.spec.ts`, re-run here; "before A2" numbers from the implementer's bench log `phase0x/A2/bench-run2.log`, not re-run) | warm open: 5 local reads before the first code, 7 in all (before A2: 17 / 19). Restart + unlock: 8 before the first code, 10 in all (before A2: 34 / 36). The report's "open 16 -> 4" compares unit numbers; "34 -> 7" compares a browser baseline with a unit result |

## Findings introduced or affected by A2

### A2-1 (Medium): a mirror that keeps failing pins the marker; every open repeats the full cleanup
- **Where**: `store.ts:444-459` (`mirror = "unreadable"` → `done = false` → return before `sk_store_v` is written and
  before the marker is removed); `service.ts:144` (`openView` runs housekeeping whenever `cleanupDue`).
- **Sequence** (`a2-review.test.ts`, "REPRO (perf)"):
  1. A password vault in its steady state.
  2. IndexedDB starts failing every get and set, as Chrome's "Internal error opening backing store" does until the
     profile is repaired.
  3. The user rotates the key. The primary store is cleaned, the mirror is not, so the marker stays.
  4. From then on, every unlocked popup open makes **21** local reads: the other slot, the keyring copy, the index,
     every snapshot, then `keys()`, which in `ChromeLocalKV` is `get(null)` and reads the whole store. At 500 accounts
     that is an estimated 7 MB per open (17 snapshot reads plus one full read of about 19 copies of ~200 KB), forever. Before A2, an open made 18 reads and only an unlock scanned.
  5. With no key change at all: an existing user whose IndexedDB is already broken at upgrade never gets `sk_store_v`
     written. The one-time check therefore repeats at every open from day one.
- **Fix**: when the primary store is clean and only the mirror failed:
  - write `sk_store_v` and replace the marker with a mirror-only flag, e.g. `sk_keychange = {v:1, vkId, at, mirror: true}`;
  - have `cleanupDue` ignore that flag on open;
  - retry the mirror part only from `finishUnlock` and from `selfCheck` (whose `restoreRedundancy` already overwrites a
    device-key mirror gen).

  A smaller alternative: try the cleanup at most once per browser session, with a flag in `chrome.storage.session`.
  Either way the safety does not change: the mirror's old copy stays until IndexedDB works again, exactly as now.
- **Blocks merge**: yes (cheap, and it defeats the gate for a real group of users). **Blocks M2**: no.

### A2-2 (Medium): the hard gate does not measure the popup's real path
- **Where**: `test/unit/read-budget.test.ts:105` (`measureOpen` counts `loadScreen` only). The reads it misses:
  - `src/popup/main/Main.tsx:53`: `getSettings()`, on the critical path. The list is not drawn until it returns. The
    comment at `Main.tsx:41-43` says this read goes away once A2 lands, but `Main.tsx` belongs to lane B.
  - `src/popup/App.tsx:25`: `touch()`, which costs 2 local reads through `RoutedSession.always()`.

  The static check at `read-budget.test.ts:217` only looks for `.service.status(` and `.service.read(`.
- **Sequence**: run the implementer's own `test/e2e/perf.spec.ts`. It prints "local reads up to the first code 5, whole
  open so far 7" and, for an unlock, "until the first code 8 … in all 10"; the counts are deterministic (min = max over
  15 bench runs). The unit gate still passes at 4 and 7. Any read added later to `Main`, `List`, `Notices`, the hooks
  or `touch()` is equally invisible to the gate.
- **Fix**:
  1. B1, which owns `Main.tsx`, takes `display` from `screen.settings` and drops the read.
  2. Turn the deterministic counts in `perf.spec.ts` into hard assertions: before the first code ≤ 5 now (≤ 4 after
     B1); unlock ≤ 8 before the first code.
  3. Optional: have `RoutedSession` read the mode once per `touch()`.
- **Blocks merge**: no. The plan scoped the gate to `loadScreen`, and `Main.tsx` is not A2's file. Track it as a B1
  hand-off with the hard e2e counts. **Blocks M2**: no.

### A2-3 (Low): the cleanup now deletes snapshot records it cannot parse, including records from a newer version
- **Where**:
  - `store.ts:491`: `staleIn` counts `!rec` (damaged **or** an unknown record format) as stale, so it triggers the
    cleanup by itself;
  - `store.ts:545`: `rewriteInner` deletes such records;
  - `format.ts parseStoreVersion` / `store.ts:81`: any `sk_store_v` other than `{v:2}` means "check".
- **Sequence** (`a2-newer.test.ts`):
  1. A newer build writes a snapshot record `{v:2, …}` and its own `sk_store_v: {v:3, …}`.
  2. The user downgrades.
  3. The first unlock deletes that record.

  The unpatched build keeps it: `hasStaleKeyMaterial` ignored records it could not parse. This conflicts with the rule
  `openVault` follows: "a newer schema is never recovered around".
- **Fix**:
  - in `staleIn` and `rewriteInner`, treat a record whose `v` (or whose envelope version) is greater than this build
    knows as neither stale nor deletable; only plainly malformed records count as damaged;
  - in `cleanupDue`, treat an `sk_store_v` with `v > 2` as "a newer version owns this, do not clean".
- **Blocks merge**: no (downgrade only), but it is two lines and worth doing in A2. **Blocks M2**: no.

### A2-4 (Low now; must be decided before M2): copies under an unknown or newer key are dropped by the next cleanup that runs
- **Where**: `store.ts:546-556`: a snapshot that `reencrypt` cannot re-encrypt is removed. `reencrypt` only knows
  `keyring.previous`. The behaviour is documented at `store.ts:24-26`.
- **Sequence**:
  1. A password vault on K1 with the mirror failing writes (so the mirror keeps K1).
  2. `rotateKey` moves the vault to K2. The marker stays (A2-1).
  3. The user adds accounts under K2.
  4. Both slots and the keyring copy are damaged. Recovery falls back to the mirror's K1.
  5. At the next unlock, `finishKeyChange(K1)` drops every K2 snapshot.

  In Phase 0 this loses nothing that could still be opened: if K2's keyring were still on disk, recovery would have
  picked K2. With M2, K2's keyring can come back from the server (adoption, previous-VK fallback), and those snapshots
  may be the only local copy of edits made under K2. The plan (A2 risks) expected these copies to be **kept** once
  scanning stops. They are kept by plain opens and unlocks, but not by the marker cleanup or the one-time check.
- **Fix before M2**: in strict mode, keep snapshots under a vkId that is neither current nor in `previous` (or keep them
  only when their seq is above the current generation's). Do not count them as stale. Handle crowd-out (P-6) separately.
- **Blocks merge**: no. **Blocks M2**: yes (a decision is needed).

### A2-5 (Low): blind spots of the differential test
- **Where**: `test/fault/open-view-diff.test.ts:351` (the "afterwards" check compares screens only) and `:321`
  (`READ_TOGETHER`).
- **Evidence**:
  - **The "afterwards" check cannot see deletions.** Mutant M4-diff (the cleanup swallows read errors, then deletes)
    **survives** the whole differential test: the screens match while a snapshot was deleted on account of a read that
    failed. Only `keychange-marker.test.ts` "a read that fails during the cleanup…" kills it.
  - **Shared code is invisible.** `recover()` runs on both paths, so its swallowed reads (P-4) cannot show up as a
    difference.
  - **`READ_TOGETHER` is two keys wider than needed.** Dropping `KEYS.active` or `"sk_last_backup"` still passes,
    because the old path fails on those reads too. The minimal set, `{events, keyChange, storeVersion, sk_settings}`,
    passes; `sk_settings` is needed only for device-key vaults.
- **Fix**:
  - in "afterwards", also compare the set of valid snapshot records (id → checksum) in both stores and the slots;
  - shrink `READ_TOGETHER` to the minimal set, keyed by vault kind;
  - add a disk-level assertion to part 3: "no record that existed before is gone unless the old path also removed it".
- **Blocks**: no / no.

### A2-6 (Low, but blocks merge as a test gap): mutants that survive the package's own tests
The full mutation table is below. Of the plausible bugs, the package's own tests miss these:
- **M8**: `finishKeyChange` without the lock. Killed only by this review's probe "openView's cleanup in one context,
  edits and a key rotation in another" (two services over one store, one shared mutex). Without the lock, the cleanup
  overwrites the other slot from a generation read before a concurrent edit, and the edit is lost. Rule 6 of §0.2
  requires a test for this.
- **M3a**: `staleIn` skips the keyring copy. Unreachable through today's operations, since the primary rewrite always
  writes the copy, but nothing pins it. A device-key copy left there would defeat the master password, and only
  `selfCheck` would catch it.
- **M5b**: a device key going away without a vkId change does not mark. Equivalent today, because `rekey` always makes
  a new VK. It is the hook M2 relies on.
- **M7b**: the marker read before the lock. An equivalent mutant: staleness is re-verified under the lock and `vk` is
  checked.
- **Fix**: add the two-context probe from `a2-review.test.ts` ("PROBE: cleanup and writes from two contexts at once")
  to `keychange-marker.test.ts`, plus two planted-state tests: only the keyring copy old, and a transact that strips a
  device key while keeping the vkId.
- **Blocks merge**: yes (tests only). **Blocks M2**: no.

### A2-7 (Info): budget
- **Where**: `scripts/check-dist.mjs` output; PHASE0X-PLAN Appendix C.
- **What**: popup +1.0 KB gz, against the plan's +0.2 KB (50.4 → 51.4, under the 60 KB limit).
- **Fix**: update Appendix C. **Blocks**: no / no.

### A2-8 (Info): wording and plan deviations, all in the safe direction
- **`selfCheck` timing.** `store.ts:22` says `selfCheck` runs at "service worker start". It runs only on
  `onStartup`/`onInstalled` (`sw.ts:35-36`), not on every wake (`routine(false)`). The backstop is once per browser
  session, and it covers only device keys:
  - the other slot, when the active keyring has none;
  - the keyring copy, whenever it differs;
  - the mirror gen.

  Old keys after a rotation (no device key) are covered by the marker alone.
- **`read()` still scrubs unconditionally.** The settings page's `read()` still runs `scrubStaleDeviceKey` on every
  call, although the plan said "only with a marker". That is more scrubbing, not less.
- **`sessionVk` duplicates `currentVk`.** `service.ts:184` is a deliberate copy of `currentVk`. Any later change to the
  session rules (A3, C7) must touch both; the differential test covers 5 session states.
- **Fix**: correct the comment at `store.ts:22`, and record the scrub deviation and the `sessionVk` rule in the M2
  hand-off. **Blocks**: no / no.

### A2-9 (Info): one read more than needed
- **Where**: `service.ts:140` and `platform/session.ts:37`.
- **What**: `openView` reads the settings twice, once in `RoutedSession.always()` and once in `getView()`.
- **Fix** (optional): pass the settings already read into the router; an open would then be 3 reads.
- **Blocks**: no / no.

## Pre-existing problems (not introduced by A2)

### P-1 (High): a key change that "failed" at the commit is committed later by selfCheck — issue (a)
- **Where**: `store.ts:166`. `recover()`, run by `selfCheck` at browser start and on install or update, lets the slot
  with the higher seq win over a valid slot that the pointer names. Every `load()` trusts the pointer instead, so the
  two disagree. The operations at risk are all keyring changes:
  - `service.ts:435 rotateKey`, `:413 enableMasterPassword`, `:502 resetPasswordWithRecovery`;
  - also `:524 newRecoveryCode` and `:489 changePassword` (same mechanism, not reproduced separately).
- **Reproduced** (`a2-review.test.ts`, "REPRO (a)", and `a2-death.test.ts`):
  - **rotateKey**: an I/O error at the pointer write. The user is told it failed, and every `load()` still shows K1.
    `selfCheck` then commits K2. The saved recovery code returns `wrong_secret`; the new code was never shown.
  - **resetPasswordWithRecovery** (recovery code R1, new password P2): after `selfCheck`, neither the old password nor
    R1 opens the vault. Only P2 does, the password the user was told was not set. Retrying the reset with R1 is refused
    with `wrong_secret`, so this can lock the user out.
  - **enableMasterPassword**: after `selfCheck` the vault is password-protected, with a recovery code nobody saw.
  - **process death at the same write**: the same outcome. FIXb below does not cover this case; FIXa2 does.
  - **with A2, if a popup opens first** (the old key's session still alive): the marker cleanup overwrites the
    uncommitted slot, so the change is rolled back instead. The outcome depends on which runs first.
- **Smallest safe fix**, both variants run in the scratch tree. Each passes the full unit suite: only the 3 REPRO tests
  flip, and `store.test` and the differential test stay green.
  - **FIXb** (I/O-error path; always safe). In `transact`, wrap the three writes "slot, verify, pointer" in a
    `try/catch`. If they throw, write `prev` back to the target slot (best effort, ignoring errors) and rethrow. If the
    pointer write actually landed before throwing, both slots now hold `prev`, which matches the failure the user was
    told about.
  - **FIXa2** (process death). In `recover()`, when the pointer names a valid slot and the newer slot it does not name
    carries a **different keyring**, keep the pointer's slot. That makes `selfCheck` agree with `load()` and with A2's
    own marker cleanup. Ordinary saves keep "highest seq wins".
    - Trade-off for the owner: on a power loss that drops only the pointer write, after the user already saw the new
      code, the key change is rolled back. The old code and old password then work, and the new code does not.
    - FIXa, the unconditional version (the pointer always wins), also passes everything. It would make the same
      trade-off for ordinary saves too, so it is not recommended.
  - **Robust fix (later)**: show the new recovery code before the commit (prepareKeys-style, as A1 does for creation),
    or keep a "recovery code changed but not confirmed" flag that the UI clears.
- **Blocks A2 merge**: no (A2 neither causes it nor makes it worse).
- **Must be fixed before A1/A2 ship to users**: **yes, FIXb**. It is 6 lines and has no trade-off, and A1 makes every
  vault password-protected, so from then on every user can reach this through reset and rotate.
- **Owner decision**: FIXb alone, or FIXb plus FIXa2. FIXa2's cost: if a power loss drops only the pointer write, a key
  change the user saw succeed is rolled back.
- **Blocks M2**: yes, with FIXa2 or the show-before-commit flow in place. M2 requirement 2 writes the identity record
  (`vkId`, `maxSeenKver`) only after the keyring transact succeeds. A "failed" adoption that `selfCheck` commits later
  leaves the identity and the keyring out of step.

### P-2 (Medium): addSnapshot swallows a failed index read — issue (b)
- **Where**: `store.ts:371` (`readIndex` returns `[]` on a throw) and `store.ts:259-265`.
- **Reproduced** ("REPRO (b)"):
  1. One transient failure reading `sk_snap_idx` during an ordinary save. The save itself succeeds.
  2. The index is rewritten with only the new snapshot.
  3. At the next browser start, `gcSnapshots` deletes every other record as an orphan.
  4. With 5 or more snapshots, rolling and daily, 1 remains.
- **Fix**:
  - read the index strictly in `addSnapshot`; `guarded()` already logs the error, and the save still succeeds;
  - in `gcSnapshots`, re-index valid orphan records instead of deleting them, or delete only orphans older than the
    oldest indexed seq.
- **Blocks**: no / no (recommended before M2: sync adds more writes).

### P-3 (Medium, new): purgeForever empties the snapshot index after one failed read
- **Where**: `service.ts:594` calls `rewriteForKeyChange`, which runs non-strict. `store.ts:540` uses `readIndex`
  (which swallows errors), then `kv.set({snapIndex: []})`.
- **Reproduced** ("REPRO (purge)", third test):
  1. One transient failure on the second index read during `purgeForever`.
  2. The index is set to `[]`; the records stay on disk.
  3. The next `selfCheck` deletes every snapshot as an orphan.
- **Fix**: use the strict mode A2 added (reads propagate) for `purgeForever` too. The purge then fails visibly and can be
  retried. The mirror part stays guarded.
- **Blocks**: no / no.

### P-4 (Medium): recover() swallows read errors — issue (c)
- **Where**: `store.ts:179-180` (`readMirrorGen`, `safeGet` of the keyring copy), `readIndex`, `snapshotCandidates`.
- **Reproduced** ("REPRO (c)"):
  1. Both slots and the keyring copy are damaged, and the mirror holds the data.
  2. One transient mirror read error: the popup shows **"lost"**.
  3. The next open shows the vault.

  The Lost screen leads to restore or start over, which overwrites the mirror gen in its own transact. The same swallow
  can also make recovery choose an older source. The differential test cannot see any of this, because both paths
  share `recover()` (A2-5).
- **Fix**:
  - in `recover()`, remember whether any source read threw;
  - if one did and nothing usable was found, throw. The popup then shows the error screen with Retry, instead of
    returning `lost` or restoring from an older source.
- **Blocks**: no / no (recommended before M2).

### P-5 (Low): the old password or recovery wrap of the same VK stays in the other slot — issue (e)
- **Where**: `service.ts:489 changePassword`, `:524 newRecoveryCode`, `:502 resetPasswordWithRecovery`. These are
  same-vkId transacts: no marker, and the other slot keeps the previous keyring.
- **Reproduced** ("REPRO (e)"):
  - after `changePassword`, the **old** password unwraps the VK from the other slot, and that VK decrypts the
    **current** envelope;
  - after `newRecoveryCode`, the old code does the same;
  - the keyring copy and the mirror are updated; the next save overwrites the other slot.
- **Security impact**: someone who knows the old password (the usual reason to change it) and copies the profile before
  the next save can open everything. Because of LevelDB residue (SECURITY.md "Limits"), changing the password was never
  a remedy for a leaked password on a profile that may be copied; the incremental exposure here is the window until the
  next save plus compaction.
- **Fix**:
  - in the same transact, after the commit, overwrite the other slot with the new generation (the way
    `scrubStaleDeviceKey` does, but unconditionally); or have `staleIn` compare the full keyring (`canonicalJson`) and
    mark when a wrap is removed;
  - SECURITY.md (package D): "if your password or recovery code leaked, use Rotate key".
- **Blocks merge**: no. **Blocks M2**: yes, for same-VK adoption of a remote password change.

### P-6 (Low): snapshot crowd-out over lost data — issue (d)
- **Where**: `store.ts:330` (`seq` restarts at 1 when `prev` is null) and `store.ts:373-376` (rolling snapshots are
  ranked by seq).
- **Reproduced** ("REPRO (d)"):
  1. `restoreBackup` over unreadable remains whose snapshots have seq 31–40.
  2. Three saves on the settings page (`read()` never runs the cleanup).
  3. The new vault keeps no rolling snapshot at all.

  A2 improves this: the next popup open cleans up, where before only the next unlock did.
- **Fix**: after overwriting lost data, start `seq` above the highest seq on disk.
- **Blocks**: no / no.

### P-7 (Low, new): purgeForever drops old-key snapshots that are waiting to be migrated
- **Where**: `service.ts:600`. Each snapshot is re-encrypted under its **own** key (`key`), and `rewriteInner`
  (`store.ts:549`) then drops everything not under the current key.
- **Reproduced** ("REPRO (purge)"): a pending key change with K1 snapshots still present.
  - `openView` re-encrypts them and keeps them;
  - `purgeForever` deletes them all.
- **Fix**: encrypt under `vk`, the current key.
- **Blocks**: no / no.

### P-8 (Info): a 65th key rotation fails
- **Where**: `keyring.ts:125` and `keyring.ts:258-275`.
- **What**: `validateKeyring` rejects a keyring with more than 64 `previous` entries, and Phase 0 `rekey` does not cap
  the list, so the 65th rotation fails with `verify_failed`. See also question 3.
- **Fix**: M1's `capPrevious`, applied in the Phase 0 rotation path too. Until then, `rotateKey` should refuse with a
  clear error.
- **Blocks**: no / no.

### P-9 (Info): a broken mirror stops the "is there a vault" check
- **Where**: `store.ts:244-248`.
- **What**: `hasAnyData` lets a throwing `mirror.keys()` propagate. On a fresh install, or any recovery that reaches
  the "no source" branch, the popup then shows the error screen instead of the welcome or Lost screen. With an
  IndexedDB that stays broken, a fresh install can never create a vault. Seen while writing the A2-1 probe.
- **Fix**: when the primary store holds no vault keys and the mirror cannot be listed, log it and decide from the
  primary store alone. The mirror is best-effort, and its writes are already guarded.
- **Blocks**: no / no.

## The questions asked, in order

1. **Write paths that can leave old-key material without a marker.**
   - **Key changes** (enable, rotate; M2 adoption through `transact`): the marker is written before the slot write, and
     a failure to write it fails the save. The crash matrices in `keychange-marker.test.ts` (every write, crash before or
     after it, "marker alone" and with `sk_store_v`) pass, and M1a, M1b, M5d and M16 are killed.
   - **Recovery through `writeBoth`** (no marker): it uses the newest source keyring. It can pick an older keyring only
     while a marker is pending, or after an external rollback of one store. What it then leaves behind is copies under a
     *newer* key with no keyring on disk. Those are not secrets (see A2-4 for M2).
   - **`restoreRedundancy` leaving a valid old-key other slot**: only possible while a marker is pending. When the marker
     is clear, every copy has been verified under the current key.
   - **`purgeForever` with a marker pending**: it creates nothing old and does not clear the marker. It does lose
     history (P-7) and can empty the index (P-3).
   - **A crash before the pointer flip**: the marker is already written. The residue is safe; the recovery code is not
     (P-1).
   - **`restoreBackup` / `startOver` over lost data**: marked (M5c killed). Over an empty store there is nothing old.
   - **Decrypt fallback**: the envelope must open under the current `vk`, and the keyring is the current one;
     `checkGeneration` rejects a mismatch. Nothing is written under another key.
   - **Not covered**: same-VK wrap changes (P-5). The "old material" definition is by vkId.
   - **M2 key adoption**: covered automatically if it goes through `transact`. The invariant comment at `store.ts:10-26`
     states this, but nothing enforces it.
2. **The steady-state test that accepts residue without a marker.** Its assumption holds for this version's code: no path
   above creates old-key material without a marker. The test's own claim, "selfCheck still removes a device key", is
   accurate but narrow:
   - `selfCheck` runs only at browser start and on install or update;
   - it scrubs device keys only;
   - it leaves a rotated (non-device) old key in the other slot alone.

   For rotations, the marker is the only mechanism.
3. **The version rule (the keyring's `previous` list) under the 64-entry cap and M2 adoption.** The rule only matters
   for key changes made without a marker (older builds, which do not cap the list) or after the marker key itself is
   lost. M6b and M6d are killed; M6d shows that the `previous` restriction is what keeps newer-key copies. The cap
   cannot bite: a gap of more than 64 rotations between checks needs more than 64 unmarked rotations. M2 adoption
   writes its own marker. The remaining hole needs a double fault: both the marker and `sk_store_v` lost, and then an
   adoption of a keyring that does not list the local key.
4. **`READ_TOGETHER` and `both()`.**
   - `READ_TOGETHER` is wider than needed by `KEYS.active` and `sk_last_backup` (A2-5).
   - `both()` is correct: `openVault`, which may write during a decrypt fallback, always finishes before `openView`
     returns or throws (M11 is killed by the differential test). The other awaits in `openView` and `finishUnlock` are
     sequential.
5. **Does the shared `recover()` hide a divergence?** Yes, by construction. The "afterwards" check also compares screens
   only, so a cleanup on the new path that deletes data after a failed read survives the differential test (M4-diff).
   See A2-5 and P-4.
6. **Does the read gate measure the real path?**
   - The wiring is real: `createRuntime` and `loadScreen`.
   - `App.tsx` reaches `openView` only through `loadScreen`, and `Locked` uses the returned view; nothing in the popup
     calls `status()` or `read()`.
   - The gate can still pass while the real path regresses: `Main.tsx:53` and `touch()` are outside it, and the real
     popup is at 5 / 7 reads (A2-2).
7. **Never lose data.**
   - New ways an open can fail: a transient failure reading `sk_events` now fails the open (with Retry) where the old
     path ignored it, and so does a failed `sk_settings` read for a device-key vault. Both fail safe: nothing is written.
   - New ways an open can delete data:
     - the cleanup now runs on **open**, including the one-time check for every existing user;
     - it deletes records it cannot parse, including newer-format records (A2-3, a regression from the unpatched build);
     - it deletes copies under an unknown key (A2-4).
   - **"Drops anything it cannot re-encrypt"**:
     - acceptable in Phase 0 for copies under a newer key, because nothing on disk can open them;
     - not acceptable for a snapshot from a newer app version: under the current key it is kept, but a record in a
       newer format is deleted (A2-3);
     - not acceptable once M2 can bring keyrings back (A2-4).
   - A read that throws propagates in `loadView` and `finishKeyChange` (M4, M4b and M24 are killed), and a cleanup that
     fails never fails the open or unlock (M19 is killed).
8. **Concurrency.**
   - Every read-then-write step holds the `sixkey-vault` lock: `transact`, `finishKeyChange`, `loadView`, `recover`.
   - `finishKeyChange` returns `done: false` if the key moved on (M7a is killed).
   - The two-context probes (cleanup + edits + rotation, and M2's `keyChange: true` hook racing a cleanup) pass. M8
     fails them, and nothing in the package tests this (A2-6).
   - `lockEpoch` and expiry are handled exactly as in `currentVk` (M17 and M18 are killed).
   - The window between `loadView` and `openVault`'s fallback transact is the same TOCTOU as before A2, and harmless:
     candidates are read again, and `checkGeneration` rejects a keyring and envelope that do not match.

## Mutation testing

Each mutant is one change in a fresh copy, run against `keychange-marker`, `open-view-diff`, `store.test`, `read-budget`,
`service.test`, `enable-crash` and this review's `a2-review.test.ts`. "Pkg" means killed by the package's own tests.

| Id | Mutation | Result | Killed by |
|---|---|---|---|
| M1a | marker written after the slot write | killed | pkg (crash matrix) |
| M1b | marker written after the commit | killed | pkg |
| M2 | marker cleared although the mirror failed | killed | pkg |
| M3a | verify step skips the keyring copy | **survived** | — |
| M3b | verify step skips unindexed records | killed | pkg |
| M3c | verify step ignores an old keyring in the other slot or mirror | killed | pkg |
| M3d | verify step skips the mirror | killed | pkg |
| M3e | verify step ignores snapshots under another key | killed | pkg |
| M4 | cleanup swallows read errors | killed | pkg (one test only) |
| M4b | strict rewrite swallows read errors | killed | pkg |
| M5 | `keyChange: true` ignored | killed | pkg |
| M5b | device-key removal alone does not mark | **survived** | — (equivalent today) |
| M5c | overwriting lost data does not mark | killed | pkg |
| M5d | a vkId change does not mark | killed | pkg |
| M6a | no `sk_store_v`: no one-time check | killed | pkg |
| M6b | version rule off | killed | pkg |
| M6c | a damaged marker not counted | killed | pkg |
| M6d | version rule widened to any mismatch | killed | pkg |
| M7a | no "vk still current" check in `finishKeyChange` | killed | pkg |
| M7b | marker read before the lock | **survived** | — (equivalent) |
| M8 | `finishKeyChange` without the lock | killed | **review probe only** |
| M9 | `openView` never cleans up | killed | pkg |
| M10 | unlock never cleans up | killed | pkg |
| M11 | `both()` replaced by `Promise.all` | killed | pkg (differential test) |
| M12 | events not re-read after a recovery | killed | pkg |
| M14 | strict rewrite keeps unindexed records | killed | pkg |
| M15 | rewrite keeps a snapshot it could not re-encrypt | killed | pkg |
| M16 | marker write not awaited | killed | pkg |
| M17 | `openView` ignores the lock epoch | killed | pkg |
| M18 | `openView` ignores session expiry | killed | pkg |
| M19 | a failed cleanup fails the open | killed | pkg |
| M21 | mirror-only staleness never rewritten | killed | pkg |
| M22 | `sk_store_v` never written | killed | pkg |
| M24 | `loadView` swallows a failed slot read | killed | pkg (differential test) |
| M4-diff | M4 against the differential test alone | **survived** | (A2-5) |
| RT-active / RT-sk_last_backup / RT-min | `READ_TOGETHER` narrowed | **survived** | (the allowance is unused; A2-5) |

Against the package's own tests the survivors are M3a, M5b, M7b and M8; with the review's probes, M3a, M5b and M7b
(M5b and M7b are equivalent mutants).

## Checked and found sound
- **Marker crash safety**: before the slot write; a failed marker write fails the save; cleared last, under the lock,
  after both stores were verified; the mirror's failure keeps it. Covered by the crash matrices, M1a, M1b, M2, M16,
  M21 and M22.
- **One-time migration**: no `sk_store_v` → one full check. A legacy device-key vault is checked at
  `enableMasterPassword`, which marks. Old builds ignore `sk_keychange` and `sk_store_v` (`hasAnyData`, and
  `gcSnapshots`, which only touches `sk_snap_*`), so the rollback note in the plan holds.
- **Differential test coverage**: it reaches every recovery branch deterministically (20 fixed cases, both vault kinds)
  and in 250 random runs. The crash-at-every-write part covers the new path's repairs.
- **The popup's real call path**: `App.tsx` → `loadScreen` → `openView`; `Locked` → unlock → `screenOf(view)`. A reset
  reloads.
- **Unchanged files**: `enable-crash.test.ts` and `store.test.ts` are unchanged. The `service.test` migration matches
  the plan: the marker is planted back, plus the new "before the marker existed" test.
- **Read errors**: they propagate in all new reading code (`loadView`; `finishKeyChange` and `staleIn` in strict mode).
- **Bench scripts**: `scripts/bench/*` hold no hard-coded session paths and write only under `$SIXKEY_BENCH_DIR`.
- **Plan constraints**: no new permissions, no new network, no files outside A2's ownership (the patch touches none
  of `src/core/sync`, `contract`, `api` or `SYNC-DESIGN`).

## Closing verdict

**MERGE AFTER FIXES.**

**Before merge** (all small):
1. **A2-1**: stop a broken mirror from pinning the cleanup on every open. Use a mirror-only flag that is retried at unlock
   and at `selfCheck`, or try at most once per browser session.
2. **A2-6**: add the two-context lock probe and the two planted-state tests (keyring copy only, device key removed with
   the same vkId) to `keychange-marker.test.ts`.

**Recommended in A2**:
- **A2-3**: never delete records from a newer format; treat an unknown `sk_store_v` as "not mine to clean".
- **A2-5**: compare disks, not only screens, in the differential test, and shrink `READ_TOGETHER` to
  `{events, keyChange, storeVersion, sk_settings}`.

**Follow-ups**:
- **A2-2**: B1 removes the `Main.tsx` settings read, and the `perf.spec.ts` read counts become hard assertions.
- **A2-4**: decide before M2 whether to keep copies under unknown keys.
- **P-1**: FIXb before A1/A2 ship to users; FIXa2 or show-before-commit before M2.
- **P-2, P-3, P-4**: recommended before M2.

| Severity | Introduced or affected by A2 | Pre-existing | Total |
|---|---|---|---|
| High | 0 | 1 (P-1) | 1 |
| Medium | 2 (A2-1, A2-2) | 3 (P-2, P-3, P-4) | 5 |
| Low | 4 (A2-3, A2-4, A2-5, A2-6) | 3 (P-5, P-6, P-7) | 7 |
| Info | 3 (A2-7, A2-8, A2-9) | 2 (P-8, P-9) | 5 |

**Top 3**
1. **P-1 (High, pre-existing).** A key change the user was told had failed is committed by `selfCheck`. The saved
   recovery code dies, or a reset locks the user out. Fix: FIXb (6 lines, before shipping) plus FIXa2 (owner decision,
   before M2).
2. **A2-1 (Medium).** A persistently failing IndexedDB pins the marker, so every unlocked open does the full scan:
   21 reads, including a whole-store `get(null)`. For users whose IndexedDB is already broken at upgrade, this starts
   on day one.
3. **A2-6 / A2-2 (test and gate gaps).** No test in the package pins the cleanup's lock (M8 survives). The hard gate
   measures `loadScreen` only, while the real popup is at 5 / 7 reads (open) and 8 / 10 (unlock).
