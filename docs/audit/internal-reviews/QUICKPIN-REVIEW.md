# Quick PIN (QUICK-UNLOCK Stage 1): security and UX review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "independent" removed from
> the heading and the absolute scratchpad path shortened. Paths under `scratchpad/` were the reviewer's temporary
> working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record
> quotes it or as it was adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md);
> how to read these records: [`docs/audit/README.md`](../README.md).

Reviewed: `$S/quickpin/QUICKPIN.patch` applied with `patch -p1 -E` to an rsync copy of the live repository
(`$S/quickpin-review/tree`), catalogs regenerated (`python3 scripts/messages.py`: 483 messages). Here `$S` is
the reviewer's `scratchpad/` directory. The live repository
was not touched. Line numbers refer to the patched tree.

**Verdict: merge after fixes.** There are no blockers. The design's core promise holds: nothing on disk opens the vault
with a PIN (§1 proves it). There are two majors:

- **M1.** The owner's rule "a password change ends the PIN" is not crash-safe.
- **M2.** The popup budget is already spent with the gate open. The fix for M1 alone breaks CI there, and the
  implementer's recommended remedy names a module split that was already done in M6.

Both have measured, cheap fixes. Prototypes of the fixes pass every probe below and the existing quick, service and
key-change crash-matrix suites.

What was run (all `nice -n 19`, vitest `--maxWorkers=2`, targeted files only, no e2e):

- **The patch's own tests:** the five new files, 70/70 pass.
- **Review probes:** 17 tests. Six fail on the patch, as intended; each failure demonstrates a finding.
- **The same probes on the prototype fixes:**
  - all 17 pass, together with the quick-pin service, crash, crypto, read-budget, source-rule and service-worker wiring
    suites (94/94);
  - `service`, `read-budget`, `m2-source-rules`, `security-log` and `settings` pass (145/145);
  - `gm2-crash-matrix`, `keychange-marker` and `gm2-fixes` pass (83/83);
  - the one environmental failure was `sync-crypto-hygiene`, which needs `../contract`, absent from the scratch copy.
- **Several prod builds** (gate closed; gate open alone, with the fixes, with the lazy split, and with both), measured
  byte-exact the way `check-dist` counts (`probes/popsize.mjs`). Each one was also run through `check-dist` itself.
- **The prototypes:** `tsc --noEmit` and `prettier --check` pass on them.

---

## Findings, ranked

### Blockers

None.

### Major

**M1. A same-key password change, reset or adoption leaves the old PIN working for up to 12 h if the page dies after
the commit.** This breaks owner rule 3, "a password change adopted from another device must END the PIN", and the
notes' §2 claim.

- **Where:**
  - `src/core/service/service.ts:1136-1149` (`committed()`): onCode, then `record(kind)` at 1143, then
    `endQuickQuietly()` at 1149, all after the keyring has committed;
  - `service.ts:689-700` (`quickUsable`) and `pin-admin.ts:135-141` check only the vault id, the key id and the PBKDF2
    salt. Nothing ties an arming to the keyring's wraps.
- **Scenario:**
  1. The user changes the master password in Settings, or resets it with the recovery code. With sync on, a round in
     the settings tab adopts a new password from another device (`sync-flows.ts:431`, `keys_adopted`).
  2. The tab is closed, or crashes, while the security-log entry is written.
  3. The vault key is unchanged, so the old arming in `chrome.storage.session` still unwraps it.
  4. The PIN keeps opening Sixkey on this machine until the 12 hours end or the browser restarts. That is exactly what
     the user meant to end by changing the password.

  A rotation is safe, because the key id changes.
- **Why Major although the window is milliseconds:** the window is the tab closed during one security-log write. But
  the notes' own crash matrix (§5) treats every storage write as a point where the page dies. M1 is that same standard
  applied to an owner rule, and here the failure is silent.
- **Probe:** `probes/quick-review-probes.test.ts` R1. On the patch, `changePassword` and `commitReset` each return
  `{ ok: true, view }` for the old PIN. The rotation control passes.
- **Fix (prototyped, `probes/review-fixes.diff`):** bind the arming to the keyring's wraps.
  - `wrapsTag(k) = k.wraps.map(w => w.wrapped).join(",")` is stored as `sk_quick.wraps` at every arming: `arm()` and
    `setPin`.
  - It is compared in `quickUsable` and in `PinAdmin.state()` against the keyring that `loadView` already returns. That
    costs zero extra reads and needs no crypto.
  - Any re-wrap then voids the arming structurally, whatever the crash point or path, including future ones such as
    Stage 2's.
  - The keyring-times rewrite (kind `null`) changes no `wrapped` field, so it still keeps the PIN, as the notes want.
  - **Verified by grep:** the only writers of `keyring.wraps` are the explicit key operations in `keyring.ts`:
    - `setPassword` (227), `setRecovery` (245), `enableMasterPassword` (266), `removeMethod` (283), `rekey` (359);
    - each is recorded, so each already ends the PIN.

    `keybundle.ts:255` floors only `createdAt`. `capPrevious` touches `previous`, not `wraps`. There is no KDF upgrade
    or re-wrap on unlock. So the tag ends the PIN on nothing benign.
- **Alternative:** clear `sk_quick` inside each key transact, before it returns the new keyring. That still leaves a
  double fault: a crash combined with a concurrent arming using the old password.
- **Also:** add the PIN-liveness assertion to `test/fault/gm2-crash-matrix.test.ts`'s healthy-page check. Its new
  `getQuick/setQuick/clearQuick` pass-throughs (patch hunk at its line 112) never assert anything.

**M2. Popup budget: owner question 1's recommendation (a) is stale, and Stage 1's own follow-up fixes already break CI
with the gate open.**

- **Option (a) is already done.** "The second-stage module split SYNC-DESIGN §6/§7 already plans" was the first change
  of M6 part B (`docs/design/notes/M6-NOTES.md` §13.2–13.3: "the split took it to 57,429 B"). Its products,
  `cap-previous.ts`, `basic-encoding.ts`, `write-proof.ts` and `outbox-writer.ts`, are in today's popup chunk. There is
  no planned split left to "do".
- **The budget is enforced with the gate open.** `test/unit/m6-gate.test.ts:106-139` builds the store flavour with the
  gate open in a private copy and requires `check-dist (prod) OK`, and check-dist enforces `BUDGET_GZ`. So the 46 B of
  headroom is a CI limit today, not only at M8.
- **The fixes in this review break it.** They add 79 B, which takes the gate-open popup to 61,473 B, 33 B over.
  check-dist's own words: "popup bundle 61473 B gz exceeds budget 61440 B". Any follow-up of this size fails
  `m6-gate`.
- **Measurements** (bytes, gzip, check-dist's method: `probes/popsize.mjs`; builds in `$S/quickpin-review/gate*`):

| Build | Static | + zh_CN popup catalog | Total | Left of 61,440 |
|---|---|---|---|---|
| Store build, gate closed (ships today), this patch | 55,650 | 4,162 | **59,812** | 1,628 |
| Gate open, this patch | 57,036 | 4,358 | **61,394** | 46 |
| Gate open + this review's fixes (M1, m1–m3) | 57,115 | 4,358 | 61,473 | **−33 (fails)** |
| Gate open + `EditDialog` loaded lazily | 56,144 | 4,358 | 60,502 | 938 |
| Gate open + fixes + lazy `EditDialog` (check-dist OK) | 56,248 | 4,358 | 60,606 | 834 |
| Gate open, upper bound: settings-only key operations stubbed out of `service.ts` | 56,004 | 4,358 | 60,362 | 1,078 |

- **Cheapest safe split: load `popup/main/EditDialog.tsx` lazily** (`probes/lazy-editdialog.diff`). It saves 892 B and
  touches no security code.
  - The dialog opens only on Edit, and the pattern already exists in the same file (`confirmPage = () =>
    import("./AddConfirm")`, Main.tsx:31).
  - `siteRules` moves to a 1-line `site-rules.ts`, so `Main` no longer imports `EditDialog` statically.
  - Its CSS moves with it.
  - check-dist passes on that build, and so does the build's own key check.
  - The dialog's words stay in the popup catalog: the zh_CN popup catalog is 4,358 B in both builds, because the
    collector traces the lazy chunk too. The saving is all static JS and CSS.
  - The first Edit pays one local chunk load, as Add already does.
- **Second lever, before Stage 2 adds the device button:** move the settings-only key operations out of `service.ts`
  into an options-only module. That is rotate, change password, reset, new recovery code, enable password,
  restore/import/purge and clear log, following the pattern `pin-admin.ts` and `sync-flows.ts` already set. Its
  measured upper bound is −1,032 B. It touches audited code and many tests, so it is not the first choice.
- **Option (b), P2 as a lazy chunk,** is smaller: `state.ts` stays static for `SyncPort.context()`, so only the line's
  component and about 320 B of `keysChangedElsewhere` would move. It would also need catalog plumbing for its four
  words.
- **Recommendation:** do not raise `BUDGET_GZ`. Land the lazy `EditDialog` with, or before, the M1 fix.
- **For the record:** Stage 1 cost 3,138 B in the shipped popup and 2,918 B with the gate open. The design estimated
  +1.0–1.8 KB (§5.11).

### Minor

**m1. An unlock already under way with the old PIN still succeeds after a PIN change or removal has completed.**

- **Where:** `service.ts:781-785`. The success's compare-and-set only skips the counter reset, then `finishUnlock`
  runs anyway. `openQuick` used the spent local copy of the old arming. `setPin` and `removePin` bump no lock epoch.
- **Scenario:** a solo profile in "every time the popup closes" mode. The settings tab is unlocked in its own memory and
  changes the PIN while a slow machine derives the old PIN in the popup. The old PIN opens Sixkey once.
- **Probe:** R4 fails on the patch.
- **Fix (in the diff):** under the quick lock, refuse with `"ended"` unless the current arming still exists with the
  same key and salt. Reset the counter only when it is the same arming.
  - A new arming of the same set-up, from a password unlock elsewhere, is still accepted.
  - The 5th wrong try elsewhere during this derivation now also refuses it, which is the correct reading of "5 tries".

**m2. `quick_ended` is lost when the 5th wrong PIN races any other look.**

- **Where:** `service.ts:778` together with `dropIfSame`.
- **The race:** after the last try is spent (`triesLeft` 0, written before the derivation), any of the following
  deletes the record first:
  - a 6th attempt (`unlockWithPin`'s spend step);
  - a lock screen opening (`lockScreenQuick`);
  - the worker's `enforceQuickExpiry`, which also runs on every page's `sk-reschedule-autolock`.

  The 5th attempt's `dropIfSame` then finds nothing, and §5.4's "record quick_ended" never happens. The five
  `pin_failed` entries are still there. Only the audit trail suffers.
- **Probes:** R3 (7 concurrent attempts give 5 `pin_failed` and 0 `quick_ended`), and a sequential variant with the
  alarm firing during the derivation. Both fail on the patch.
- **Fix (in the diff):** record `quick_ended` when the current record is absent or is the same arming.

**m3. `sw.ts:40-41`: `rescheduleAutoLock()` now awaits `rescheduleQuickExpiry()` first, with no catch.**

- **Effect:** a rejection in the quick path (a `storage.session` read, a lock request) means the idle auto-lock alarm is
  never armed. It also surfaces as an unhandled rejection in the worker.
- **Why it matters:** that alarm is how an idle vault locks with no page open (`sw.ts:39`). It should not depend on new
  code.
- **Probe:** `probes/quick-review-sw.test.ts` R7 fails on the patch. Its control passes.
- **Fix (in the diff):** `void rescheduleQuickExpiry().catch(() => undefined)`.

**m4. "Ended" copy uses a stale local count.**

- **Where:** `Locked.tsx:110` and `UnlockBar.tsx:35` choose `pinExhausted` versus `pinEnded` from the page's own
  `tries`.
- **Effect:** a PIN exhausted by guesses in another page, or exhausted by this page's 5th try after others, shows "The
  PIN can't be used now" instead of "Too many wrong PINs".
- **Fix:** have the service return `reason: "exhausted"` separately from `"ended"`, which today also covers expired,
  stale and shared.

**m5. A lock screen opening concurrently with `setPin` can delete the fresh arming.**

- **Where:** `service.ts:717-726`.
- **The race:**
  1. `loadView`'s `sk_pin` read predates `setPin`'s write.
  2. Its `getQuick` comes after the new arming.
  3. `quickUsable` fails `sameSetup`, and `dropIfSame` deletes the new record, because it is "the same" as itself.
- **Effect:** in the safe direction. The PIN waits for the next master password, and the box says so.
- **Fix:** drop only for reasons intrinsic to the record (expiry, tries, ids). Leave a set-up mismatch to unlock time,
  which re-reads `sk_pin`.

**m6. The lock-order comment is wrong.**

- **The comment** at `service.ts:133-136` says `quickLock` is "never taken inside the vault lock".
- **What the code does:**
  - `makeVault` calls `saveChoice` inside `store.transact` (line 571);
  - `saveChoice` calls `updateSettings`;
  - `updateSettings` calls `hardLock` (line 498);
  - `hardLock` takes `quickLock` (line 441).
- **No deadlock today:** no `quickLock` body touches the store, so there is no reverse nesting.
- **Fix:** correct the comment to "vault, then quick; never quick, then vault". Add a source rule that `quickLock`
  callbacks only touch the session cache.

**m7. Copy.**

- **"Until the browser closes"** (`pinLead`, zh "浏览器关闭前") is wrong on macOS, where closing the last window keeps
  Chrome running, and `sk_quick` with it (design §1.3). Use "until you quit or restart the browser" ("退出或重启浏览器之前").
- **"$1 tries left"** reads "1 tries left".
- **`pinRoot`** ("…and this setting still ask for it") is true for set, change and remove, but not for "End quick
  unlock now". Say "setting or changing the PIN".
- **`quickEndNow`** also locks Sixkey. The button could say so, as the result line already does.

**m8. Docs gap (notes §9 item 13).** `local-vault.md`, `PRIVACY.md` and `ARCHITECTURE.md` do not yet name `sk_pin`,
`sk_quick`, the soft and hard locks, or the `lock` command. Under the project's audit and privacy promises, this should
land before the release, though not necessarily in this patch. The implementer's proposed text is accurate. Add M1's
`wraps` field if it is adopted.

**m9. Auto-submit uses the length from when the lock screen opened** (`Locked.tsx:189`, `quick.digits` from the mount).

- **Effect:** a PIN changed to another length while a lock screen stays open, for example the popup opened as a tab,
  spends a try on a truncated entry.
- **Fix:** take the length from the answer or the record, or disable auto-submit after a "wrong" or "ended" answer.

**m10. Nit.** The `parseQuick` comment at `pin.ts:232` says "the caller clears what is not a record", but no caller
clears an unparseable `sk_quick`. That is harmless, since it is unusable and gone at restart. Correct the comment.

### Owner notes (design-level, not defects in this patch)

- **"Erase forever" (`purgeForever`, `service.ts:1324`) and "import backup" were never behind the master password.**
  They are now reachable by whoever guesses a 4-digit PIN within 5 tries. The PIN widens who counts as "unlocked".
  - §5.1 item 6 does not list them, so this is within the design.
  - Consider adding the H3 check to Erase forever, at least after a PIN unlock. The irreversible delete is the one "never
    lose data" exposure a PIN adds.
- **The counter resets on a correct PIN** (§5.4). A T1 attacker therefore gets up to 4 guesses per legitimate cycle.
  This is acceptable: the notice counts `pin_failed`, and a PIN unlock deliberately does not ack the count.
- **Legacy profile inference** (`types.ts profileOf`): a pre-marker record that started from the Shared card and then
  changed one field reads "solo", so the PIN box offers a PIN there.
  - It is safe by construction, since a PIN still needs a deliberate set-up behind the master password.
  - A stricter reading would be: a legacy `autoLock.mode === "always"` counts as shared.
- **A clock set back by less than the time elapsed since arming extends the window.** Only a move to before `armedAt`
  minus 60 s is caught. That needs OS admin rights, which is outside T1, so it is accepted as designed. The alarm uses
  wall time too.
- **"End quick unlock now" is offered only while unlocked** (`PinBox.tsx:179`). Offering it while locked would also be
  safe, since it only takes a way in away, and it is useful when walking away.
- **Manual check to add to OWNER-DECISIONS/12:** whether Chrome's save-password bubble fires on the PIN box. It has a
  current-password field and two new-secret password fields, which look like a change-password form. All three have
  `autocomplete` set, and the extension origin probably has no password manager [unverified].

---

## Review focus, item by item

### 1. Nothing on disk opens the vault through the PIN: proved

**Every persisted write:**

- **`chrome.storage.local`** (written in `pin-store.ts:44`, `:61`, `:75`):
  - `sk_pin` = `{v, vaultId, vkId, digits, kdf: {name, salt, iterations}, iv, wrapped}`;
  - `wrapped` is AES-GCM under `HKDF(VK, ∅, "sixkey/v1/pin-cfg")` of `pinKek` (`pin.ts:79-96`);
  - it lives in `LOCAL_ONLY_KEYS` and is never mirrored, synced, backed up or exported.
- **IndexedDB:** nothing new. `pin-store` writes through `local`, not the store's mirror.
- **The security log:** kinds only (`pin_set`, `pin_removed`, `pin_failed`, `quick_ended`), no detail.
- **The diagnostics log:** error class or code only (`ui/errors.ts`, `platform/diag.ts`). The export
  (`Misc.tsx:177-183`) holds events and that log, never session contents.

**Offline brute-force from a profile copy: refuted.**

- A PIN guess needs an oracle. On disk, the only value that depends on the PIN is `pinKek`, inside `sk_pin.wrapped`.
  Checking a guess against it needs `cfgKey(VK)`.
- Without the VK, a guessed `pinKek` can be compared with nothing, and AES-GCM under an unknown 256-bit key reveals
  nothing.
- `sk_pin` does leak the PIN's length (`digits`), the salt and the iteration count. None of these is an oracle.
- With the VK, everything is open anyway. The PIN is recoverable then (10⁶ × 600k PBKDF2, minutes), which is why the
  box says not to reuse one. As designed, §5.2.
- The PIN-wrapped VK (`sk_quick`) exists only in `chrome.storage.session`.
  - Written only through `ChromeSessionCache` (`session.ts:47-55`); the source rule in `quick-source-rules.test.ts`
    holds.
  - Memory-only: gone at browser quit, restart or crash, and on extension update, reload or disable (§1.3).
  - It reaches disk only through OS swap or hibernation, as `sk_session` already can, which is documented.

**`chrome.storage.session` access level:**

- No `setAccessLevel` call anywhere, no `content_scripts`, and no `scripting` or `debugger` permission. The default,
  `TRUSTED_CONTEXTS`, therefore applies: only Sixkey's own pages, offscreen document and worker can read it.
- Probe R5 pins this as a source rule; it is adoptable.
- It survives worker restarts, which is why the `lock` command and the expiry alarm work with no page open.
- It is readable from any extension context and from DevTools. The `pinHonest` copy says exactly that.

### 2. Attempt counting

- **Enforced in one place.** `unlockWithPin` spends the try inside `webLock("sixkey-quick")` (`navigator.locks`, the
  same lock across popup, settings and worker), before any derivation. Every writer of `sk_quick` takes that lock,
  except `RoutedSession.get()`'s shared-profile sweep, which is a remove after the hard lock already ran under the lock.
- **Fan-out probe** (7 concurrent guesses, R3): exactly 5 tries spent and recorded, the record gone, and the right PIN
  refused afterwards. Interleaved lock-screen loads give no 6th try.
- **Resets:** a master-password or recovery-code unlock re-arms with 5 tries; a correct PIN resets with a
  compare-and-set. No UI path resets the counter without proof. "End quick unlock now" only deletes.
- **Crash on the 5th:** the decrement with `triesLeft` 0 lands first, so the record is unusable (`quickLive` requires
  more than 0). It is deleted at the next look or by the alarm. Correct.
- **Gaps:** m1 and m2.

### 3. Expiry and locks

- **Expiry:** 12 h absolute from `armedAt` (the last master password, or `setPin`); a PIN unlock never re-arms. The
  check runs at every use (`quickLive`), the alarm `sk-quick-expiry` backs it up, and the AAD binds `armedAt` and
  `expiresAt`. Clock forward expires early; clock back by more than 60 s ends it; residual as noted.
- **Hard locks:** each was checked in code and by the patch's tests or probe R2. The list:
  - the 5th wrong PIN;
  - "End quick unlock now";
  - a lock-mode change;
  - shared (the card, or the marker);
  - a PIN change or removal (old arming);
  - every recorded key event: `keys_adopted`, `keys_adopted_back`, `sync_on`, `password_changed`, `password_reset`,
    `recovery_code_new`, `key_rotated`;
  - a new vault;
  - a restart.

  Crash-safety for the same-key events is M1.
- **Soft locks:** Lock now, the `lock` command, idle and screen lock keep `sk_quick` and bump the epoch.

### 4. Set-up

- **Master password typed again:** `PinAdmin.passwordVk`, recorded `unlock_failed` when wrong.
- **Policy before the password:**
  - 4–8 ASCII digits after NFKC;
  - repeats, runs (with 9 next to 0) and a 25-entry list refused;
  - it covers the DataGenetics top-20 4-digit PINs [from memory, not re-checked];
  - enforced in the service, not only in the page.
- **Inputs:** `type=password`, `inputmode=numeric`, `autocomplete=off`. Labels are visible, the hint is `aria-live`,
  and the fields are emptied on success and on lock.
- **Paste is allowed.** That is right, citing NIST.
- **No PIN in the URL, logs or storage:** the patch's test plus probe review.

### 5. Quick lock

- **Lock now:** `#lock-now`, soft, then the lock screen with focus in the PIN field.
- **The `lock` command:** in the worker, top level. It works with the popup closed (the patch's sw-wiring test).
- **Racing the idle lock:** both are soft and both bump the epoch, which is harmless.
- **Open pages:** the popup (`App.tsx` epoch listener while showing main) and the settings page (`App.tsx:96-107`)
  reload on any lock. The settings `reload` sets `vault` to null when locked (`App.tsx:79-84`), so the codes are
  dropped.
- **Manifest:** `commands` is checked exactly by check-dist (`COMMANDS`, four mutants). There are no new permissions.
  `chrome.commands.getAll` and `chrome.tabs.create` need none.

### 6. Interplay

- `verifyPassword` is unchanged and refuses the PIN (test). Every H3 export, new recovery code, password change,
  rotation, clearing of the log, and every sync `pw_auth` operation still needs the master password typed in that flow.
- "Turn sync off", revoke and delete-account need `pw_auth` (SYNC-DESIGN S8, §3.14), which a PIN cannot produce.
- A lock still ends sync flows (the epoch). A PIN unlock never resumes one.
- M6 invariants are unaffected:
  - the popup's sync modules are unchanged;
  - `pin-store` imports `core/sync/local/records`, already in the popup graph (5,334 B before and after);
  - the hygiene list was updated with the reason.
- Owner note: "Erase forever", above.

### 7. Popup budget

See M2.

### 8. Accessibility and copy

- **Accessibility:**
  - one numeric password field with a visible label;
  - tries left linked through `aria-describedby`;
  - errors in `role=alert`, `aria-invalid`;
  - focus on mount and on mode change;
  - the master password always one button away;
  - `aria-keyshortcuts` only when Chrome's string is in ARIA form.

  Lock now has no visible text label (deviation 9). This is acceptable with the accessible name and the tooltip, but it
  is a design deviation the owner should see.
- **Copy honesty:**
  - `pinHonest` states what a PIN stops (people at the computer, 5 tries) and what it does not (programs, DevTools);
  - `pinShared` is truthful;
  - no Touch ID claims;
  - fixes in m7.
- **Catalog budgets:**
  - zh_CN full catalog 11.6 KB of 12 KB (notes: 11,881 of 12,288 B, 407 B left);
  - Stage 2's settings copy, about 25 strings, will not fit, so plan the box's own catalog now (design §5.11's first way
    out);
  - popup catalog zh_CN 4,162 B.

### 9. Test quality and the crash matrix

- **What is strong:**
  - broad behavioural coverage;
  - races with real interleavings;
  - write-order tests;
  - 51 hand mutants, all killed;
  - the read-budget gate;
  - a no-secret-anywhere sweep.
- **Weak spots:**
  - **The crash matrix covers the PIN's own operations only.** No key-change crash point asserts the PIN's liveness.
    The gm2 and keychange matrices only gained pass-throughs. That is how M1 survived. Adopt R1 and extend the gm2
    healthy-page check.
  - **No test for the adoption, join or `sync_on` hard lock.** R2 adds them.
  - **No fan-out beyond 2.** R3 adds 7, and the interleaved lock-screen case.
  - **The in-flight change** is untested (R4).
  - **The worker's coupling** is untested (R7).
  - **"A profile copy holds only sk_pin"** (`quick-pin-service.test.ts:499-506`) checks field names only. §1's
    argument is the real proof. A stronger test would rebuild a world from `kv` alone with an empty session and drive
    every path with the right PIN, which the restart test partly does.
- **The window-length clause** (`expiresAt - armedAt <= 12 h`) is killed by `quick-pin-crypto.test.ts:194`. There was
  no gap there.

### 10. The deviations (notes §9) and owner questions

| # | Deviation | Judgement |
|---|---|---|
| 1 | No version bump for the four new security-log kinds | **Agree.** The M6 rule that older versions keep unknown kinds supersedes §5.10's "one bump". |
| 2 | `sk_quick.kdf` holds a copy of the PBKDF2 settings, salt included | **Agree.** None of it is secret, and it saves a read. The salt doubles as the set-up identity for `sameSetup`. Iterations are not compared, which is irrelevant: only T4 can edit session. |
| 3 | "Lock when the popup closes" reuses the "always" mode | **Agree.** It is consistent with §5.8 and avoids a second option. |
| 4 | Hard lock on every key event | **Agree.** It is not crash-safe as built: see M1 and its fix. |
| 5 | `sk_pin` re-encrypted on a key change | **Agree** (§5.9 first option). It is dropped when unopenable or from another vault. |
| 6 | `PinAdmin` reaches the service by element access | **Acceptable.** sync-flows.ts is the precedent, and the source rule names both files. It widens the private-access surface; keep the list closed. |
| 7 | `loadView(also)` | **Agree.** It is guarded against naming store keys. |
| 8 | The "locked" answer | **Agree.** |
| 9 | No visible label on Lock now | **Acceptable.** Note it for the owner. |
| 10 | "End quick unlock now" asks for no password | **Agree.** |
| 11 | The notice is shown, not acked, after a PIN unlock | **Agree.** This is the right reading of the security log's rule. |
| 12 | Copy without Touch ID | **Agree.** |
| 13–14 | Docs and manual checks still to do | Required before release (m8). |

**Owner questions:**

1. **Budget.** Not (a) as written, because that split is done. Load `EditDialog` lazily now (−892 B, measured). Plan
   the settings-only key-operations split (up to −1,032 B) before Stage 2. Do not raise the limit.
2. **Alt+Shift+L:** agree.
3. **An adopted password change ends the PIN:** agree. It is built via the `keys_adopted` record (probe R2), but needs
   M1's fix to hold across a crash.
4. **End quick unlock without a password:** agree. Also consider offering it while locked.

---

## Probes (`$S/quickpin-review/probes/`)

- **`quick-review-probes.test.ts`** (15 tests), adoptable as `test/unit/`:
  - R1: crash after the commit for a change, a reset, and a rotation control;
  - R2: the hard-lock rule of `committed()` by kind;
  - R3: fan-out, and the `quick_ended` gaps;
  - R4: a change while a derivation is under way;
  - R5: `storage.session` access-level source rule;
  - R6: the shared card.

  Tests marked `[FAILS ON PATCH]` fail now and pass with the fixes.
- **`quick-review-sw.test.ts`** (2 tests): R7, the worker's idle alarm against a failure in the quick path. Its harness
  is copied from `m5-sw-wiring`.
- **`review-fixes.diff`:** prototype fixes for M1, m1, m2 and m3 in `pin.ts`, `service.ts`, `pin-admin.ts` and `sw.ts`.
  They are formatted with prettier, pass `tsc`, and pass the suites listed at the top. The comments are review-marked:
  reword them on adoption.
- **`lazy-editdialog.diff`:** the measured popup split (`Main.tsx`, `EditDialog.tsx`, new `site-rules.ts`). It is a
  prototype: it passes `tsc` and prettier, but its `editDialog` constant sits among the imports, and the comment above
  `siteRules` in `EditDialog.tsx` should move to `site-rules.ts`.
- **`popsize.mjs`:** the popup budget in bytes, check-dist's method:
  `node popsize.mjs <dist>`.

To run: copy the two test files to `extension/test/unit/`, then run
`nice -n 19 npx vitest run --maxWorkers=2 test/unit/quick-review-probes.test.ts test/unit/quick-review-sw.test.ts`.
