# A1 review (H1 + H5): review of `A1.patch`

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading and the reviewer line, repository paths updated to the current layout and
> absolute local paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes,
> mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was
> adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these
> records: [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Reviewer: a Claude Opus review session (PHASE0X-PLAN §3.4). Scope: `phase0x/A1/A1.patch` (26 files) against
> PHASE0X-PLAN A1, Appendix A/B/D, SYNC-DESIGN §9.1 H1/H5, the final review's H-a/H-c, SECURITY.md and PRIVACY.md.
> Nothing in the main tree was changed except this file. All experiments ran in a scratch copy at
> `scratchpad/a1-review/`:
> - `extension/` is the patched copy;
> - `orig/extension/` is the pre-patch tree;
> - `mutate.py` is the mutation runner;
> - `probes/zz-review-probe.test.ts` holds the probes behind F1 and F2.
>
> That folder belongs to this session and will be deleted with it. The probe code is reproduced in Appendix P so F1 and F2 stay reproducible.

## Verdict

**MERGE AFTER FIXES.** The service design holds up:
- Keys are prepared in memory and written once under the lock.
- The H5 answer is saved inside that lock.
- The handle is spent only after the commit.
- The vault id is bound.
- The `startOver` recheck is in place.

I found no path that writes a device wrap, loses an existing vault, or locks out a "shared" user. 20 of the 24 mutations I ran were killed by the patch's own tests. Of the four survivors, two touch A1's guarantees (F2, F3) and two are untested pre-existing or advisory behaviour.

One fix should land before merge (F1). It is small, and M2 builds on this API.

Counts: critical 0, high 0, medium 1, low 9, info 6.

Top 3:
1. **F1 (medium, blocks).** A write that lands but reports a failure is retried. The retry then says "set up in another page… Nothing was changed here", but the vault is this page's and the recovery code the user saved is the live one. Reproduced.
2. **F2 (low).** For new vaults, the ≥50-bit rule rests on one untested UI conditional. The service accepts `Password12345!` (21.6 bits). Reproduced, and mutation U3 survives.
3. **F3 (low).** No test pins "create never overwrites unreadable data". Two guards exist, but removing both survives the suite (S11).

## 1. Verification (scratch copy, patch applied with `patch -p1`, `python3 scripts/messages.py`, `npm run verify`)

| Check | Result |
|---|---|
| Patch applies to the main tree | Clean; the main tree is identical to `phase0x/A1/base` |
| Out-of-scope grep (§0.3) | No hits: no `src/core/sync/**`, `contract/**`, `api/**`, M1 tests, `docs/SYNC-DESIGN.md`, `_locales` |
| `keyring.ts`, `store.ts`, `session.ts`, `sw.ts` | Byte-identical to the base |
| `messages.py` | 260 messages, shard `a1.py` merged, EN/ZH key sets equal |
| `tsc --noEmit` | Clean |
| vitest | **674 passed, 1 skipped** (39 files): matches the implementer's report |
| build + check-dist | OK. **Popup 43.6 KB gz** (static 37.8 + zh_CN 5.8); base build is 42.8 KB, so A1 adds **+0.8 KB** (plan said +0.6) |
| e2e | **33 passed** (2.9 min): matches |
| `PERMISSIONS_ALLOWED` / `OPTIONAL_ALLOWED`, manifests, CSP | Unchanged (`cmp` against base) |
| `smoke.spec.ts`, `network.spec.ts`, `offscreen-race.spec.ts`, `test/fault/store.test.ts` | Byte-identical (§4.1) |
| New network or `chrome.*` APIs | None. `chrome.permissions.request` for the existing optional clipboard permissions, from a tab (allowed by §0.2) |

## 2. Findings

### F1 (medium, blocks merge: yes). After a write that landed, a retry reports "changed in another page… Nothing was changed here"

**Where:**
- `src/core/service/service.ts:201-205` (`committed()` drops the handle *before* `startSession`)
- `:212-222` `create`, `:442-457` `restoreBackup`, `:527-541` `startOver` (no "is the existing vault mine?" check)
- `src/options/FirstRun.tsx:69-81` (`run()` maps every `bad_state` to `frChanged`)
- `a1.py` `frChanged`, `frCodeNote`

**Failing sequences.** Both are reproduced in `probes/zz-review-probe.test.ts`, and both pass, which confirms the bug.

(a) The slot write lands, but the read-back throws once:
1. `transact` writes `sk_slot_a`.
2. `verifySlot`'s `kv.get` throws an I/O error, so `create` rejects with `Error` and the page shows a generic error.
3. The user clicks Finish again. `create` → `store.load()` → `recover()` finds a good slot a and sets the pointer, so a vault now exists.
4. `create` throws `bad_state("ok")`, and the page shows "Sixkey was set up or changed in another page meanwhile. Nothing was changed here."
5. A fresh service then unlocks that vault with `keys.recoveryCode`.

The same happens if the read-back returns a mismatch (`verify_failed`) for a slot that is in fact valid.

(b) The session write fails after the commit:
1. `committed()` → `preparedKeys.delete(keys)` → `startSession` throws, and the page shows a generic error.
2. On retry, `keysOf` throws `bad_state`, and the page shows the same "Nothing was changed here".

**Why it matters.** The page tells the user that nothing was changed. Step 2 said this code "will not open anything" unless the setup finished. So the user is pushed to discard a recovery code that is the only way back into a vault they really own. If they later forget the password, the data is lost. Storage faults are rare, but this is the exact case "never lose data" exists for, and the text is false.

**Fix (small):**
- In `create` / `restoreBackup` / `startOver`, before refusing, check whether the vault that exists is this handle's. If `cur.status === "ok"` and `canonicalJson(cur.gen.keyring) === canonicalJson(prepared.keyring)` (or at least `vkId` equal), the earlier write landed. Run `saveChoice(choice)` (idempotent) and `committed()`, then return success. Do the same inside the lock for `now`.
- In `committed()`, call `startSession` before `preparedKeys.delete`, so a session failure leaves the handle usable for that idempotent retry.
- Alternatively, give "handle already spent" its own error code, so the page never shows `frChanged` for it.
- In the page, after any non-`bad_state` error from Finish, call `ctx.reload()`-style status refresh the way `Security.tsx` `run()` does ("the operation may have gone through before the error; show what is true").
- Add a unit test with the two probes.

### F2 (low, blocks: no). The ≥50-bit rule for every new vault is one untested UI conditional

**Where:**
- `FirstRun.tsx:112` (`canPassword … strength?.ok === true`)
- `service.ts:175` (`requirePolicy` = `checkPasswordPolicy`, the floor only)

**Sequence.** `checkPasswordPolicy("Password12345!").ok === true`, while `measure()` gives 21.6 bits. `svc.prepareKeys("Password12345!")` succeeds and `create` makes a vault (probe). Mutation U3, which drops `strength?.ok === true`, survives every e2e test: the harness only ever types `STRONG`.

The service-side gap predates A1 and is documented in SECURITY.md ("Known gaps", second bullet). The plan requires only `requirePolicy` in `prepareKeys`, so this is spec-compliant. But after A1, `prepareKeys` is the single entry point for every new vault, so a regression in that one line would ship silently.

**Fix:**
- Add an e2e assertion: with `Password12345!` in both fields, `#fr-next` stays disabled and `#fr-strength` shows the low message.
- Optionally, let the options page inject an estimator through `ServiceDeps`, so the service enforces 50 bits without adding zxcvbn to the popup bundle.

### F3 (low, blocks: no). Nothing tests that `create` refuses unreadable data

**Where:** `service.ts:214-217`.

`create` has two guards: the pre-lock `cur.status !== "empty"` and `transact`'s default `lost_needs_confirm`. Mutation S11 relaxes both (`status === "ok"` plus `overwriteLost: true`), so `create` wipes a "lost" store, and it **survives** the whole vitest suite.

Today either guard alone is enough, but this is the never-overwrite-unreadable rule, and only `startOver` / `restoreBackup` are pinned.

**Fix.** Add a unit test:
- From `lostStore`, `create(prepareKeys())` rejects and the store is byte-identical.
- The race variant (the store turns "lost" between the pre-check and the lock) gets `lost_needs_confirm`, with nothing written.

### F4 (low, blocks: no). The language switch stays live while the wizard holds keys

**Where:** `Rail.tsx:73` (`setLangChoice(…); location.reload()`), `App.tsx:75`.

**Sequence.** On the code step, the user saves code A, then switches language.
- **If they confirm the leave prompt:** the page reloads, the keys are gone, and the wizard starts over with code B. A user who ticks "I have saved my recovery code" again without re-saving ends up with a useless code A. `frCodeNote` discloses this.
- **If they cancel the prompt:** `setLangChoice` has already written the new language, so the selector shows a language the page is not in, and every other page opens in it.

**Fix:** disable `#lang-select` while `setup !== null` (App passes a flag to `Rail`), or switch the catalog without reloading.

### F5 (low, blocks: no; integrator tracking). Two first-run promises are not true yet when A1 merges

**Where:** `a1.py` `frSharedBody` ("codes are hidden by default"), `frRiskNote` ("Settings › Security › Security mode").

- No popup code reads `display.hideCodes` yet; B1 adds that.
- There is no "Security mode" panel yet; C5 adds it.

The wording is the plan's (ux-study §2.8, verbatim in ZH), so this is sequencing, not an A1 defect. The release must not ship A1 without B1 and C5.

**Fix:** add both to the integrator's checklist, or soften the text until B1 and C5 merge.

### F6 (low, blocks: no). After a restore on a fresh install, a create wizard flashes for one render

**Where:** `App.tsx:69-71`.

`finished()` sets `setup` to null while `status` is still the old `"empty"` until `reload()` resolves. So `wizard = setupFromHash()` returns `{mode:"create"}` (the hash was just cleared), the `key` changes from `"restore"` to `"create"`, and a fresh FirstRun mounts at "Choose a master password" until the status arrives. If `reload()` fails (`setProblem`), that create wizard stays over a vault that exists, and finishing it ends in `frChanged`.

I found this by reading the code; I did not reproduce it visually.

**Fix:** in `finished` and `leave`, `await reload()` before `setSetup(null)`, or only derive `wizard` from the hash before the first status after a write.

### F7 (low, blocks: no). Cancel is not disabled while Finish is writing

**Where:** `FirstRun.tsx:115`, `:177`.

`canCancel` ignores `busy`. In startOver mode, or a restore started from the Backup panel, clicking Cancel during the write unmounts the wizard while the write still lands.

- **"Only me":** the in-flight `done()` still reaches App's `finished` through its closure, so the page catches up.
- **"Shared":** `setStep("clipboard")` lands on an unmounted component. The clipboard step is never shown, and if `leave`'s reload ran before the commit, the page keeps showing the "unreadable" banner over a vault that now exists. Pressing "Start over" again ends in `frChanged`.

No data is lost, because the code was confirmed.

**Fix:** `canCancel = … && !busy`.

### F8 (low, blocks: no; accessibility)

**Where:** `FirstRun.tsx:66`, `:119`, `:144-149`.

- The code step has no `tabindex="-1"` target. The submit button unmounts, so focus falls to `<body>`. The box is `role="alert"`, so screen readers announce it, but keyboard users start again from the top.
- The step indicator is `aria-hidden="true"` and has no text equivalent ("Step 2 of 4").

**Fix:** give the code step a focusable heading. Replace `aria-hidden` with `aria-current="step"` on the active `<li>`, or add a visually hidden "Step n of m".

### F9 (low, blocks: no). Reused ids are safe today and fragile tomorrow

**Where:** `FirstRun.tsx:217-231` (`#backup-error`, `#backup-file`, `#open-pw`, `#apply-backup`).

`App.tsx` renders either the wizard or the panels, never both, so there are no duplicate ids at runtime and the e2e selectors are unambiguous. Appendix D lists these ids as the Backup panel's contract. C6 changes `Backup.tsx` next, and any future layout that mounts both would produce duplicate ids, broken `<label for>` links, and tests that silently drive whichever element comes first.

**Fix:** either give the wizard its own ids (`fr-backup-file`, …) and migrate the three tests, or write the "never mounted together" rule into Appendix D.

### F10 (low, blocks: no). The answer stays saved after a failed write (implementer's risk)

**Where:** `service.ts:197-199`, `:218`.

`saveChoice` runs inside the lock before the slot write. If the write then fails, `sk_settings` holds the preset and no vault exists. On "empty" or "lost" this is harmless: every way to a vault asks the question again and applies the answer. `create-crash` proves that the answer is never *missing* from a vault that exists. No fix needed. Optionally, note it in the code comment.

### Info

- **I1. Prepared keys in page memory (implementer's risk).** The VK and keyring live in a module `WeakMap` until commit or GC. A restore also holds the decrypted backup in FirstRun/App state. The wizard has no idle ceiling, unlike the 15-minute one for an open page in "always" mode. This is within the A10 / physical-access model, and JavaScript cannot zero memory (SECURITY.md). Optional: drop the keys after 15 idle minutes on the wizard.
- **I2. The code is lost on a confirmed leave (implementer's risk).** It is disclosed by `frCodeNote` and guarded by `beforeunload` (Chrome ≥ 119 honours `preventDefault`; the manifest's minimum is 120). Acceptable. See F4 for the one in-page trigger.
- **I3. Pre-existing, not charged to A1.** Restore and start over over "lost" data overwrite slot a, the keyring copy and the mirror generation. That includes data that was only transiently unreadable, such as a mirror that failed one read. A1 keeps the old `overwriteLost` semantics. It improves them: nothing is erased until the code is confirmed, and `startOver` now rechecks inside the lock. A torn first write on a fresh install still turns "empty" into "lost", which is also pre-existing.
- **I4. Error text.** A `StorageError` in the wizard shows the internal code through `errText` (for example `lost_needs_confirm`). That is C8's job.
- **I5. Integrator baseline.** `enable-crash.test.ts` changes at two sites, the mechanical `create()` → `legacyDeviceVault` swap counted in H-c ("enable-crash 2"), not one as §4.1's wording says. Snapshot it after A1 as the frozen baseline.
- **I6. Docs (D's job, not an A1 defect).** After A1 merges, SECURITY.md is out of date in two places:
  - the first "Known gaps" bullet ("whether to require a master password before the first account … is a product decision");
  - the protection table's "The first-run screen therefore recommends setting the password first", which is now enforced.

  PLAN §2 D assigns both updates. PRIVACY.md needs no change, because the preset lives in the existing settings record and nothing new is stored or sent.
- **Deviation from the plan, endorsed.** The plan ordered `updateSettings(applyPreset)` before `create`. The patch saves the answer inside the locked write, after the "no vault appeared" recheck. The result is the same for the shared user (the key lands in page memory), and a losing second tab can no longer change the winner's settings or clear its session. That is strictly better.

## 3. Service flow: what I walked and found sound

**Crash points** (`create`, `restoreBackup`, `startOver`; `create-crash.test.ts` covers each write, before and after it lands):

| Moment | On disk | After restart |
|---|---|---|
| Before Finish (close tab, reload, popup closes, SW restarts) | Nothing (`prepareKeys` writes nothing; tested) | Welcome, or the same "lost" data |
| Lock taken, answer saved, slot not yet written | `sk_settings` only (F10) | Same as above |
| Slot written, pointer not | New slot | `recover()` adopts it: a vault both the password and the confirmed code open, carrying the answer |
| Pointer written (commit) | Vault | Locked. Password and code open it |
| Redundancy writes (snapshot, keyring copy, mirror) | Guarded | Healed by `restoreRedundancy` |
| Session write | — | Locked (F1 covers the retry) |

At no point is there a device key or device wrap. This is checked at every crash point and again after `ensureDailySnapshot`.

**Races:**
- Two setup tabs (unit + e2e): the loser is refused before `saveChoice`, and the winner's answer and session are untouched.
- Restore vs create, and restore vs start over in both orders (`store-misc`). Mutations S6 and S12 prove the in-lock rechecks are load-bearing.
- The same handle twice: the in-lock `now` check refuses the second.
- SW `selfCheck` during the write: same web lock.
- Lock-epoch bump during the wizard: `startSession` records the epoch after the write, so a screen lock before Finish does not void the new session. That is acceptable, because the user is present.

**Handle semantics:**
- The handle is an opaque, frozen `{vaultId, recoveryCode}`.
- Key material lives only in the module `WeakMap`.
- It is spent only in `committed()`, so a refused or failed write keeps it for a retry. That is the intended "commit the code the user already saved" behaviour.
- A spent handle cannot be used again on any path (S5 and S10 killed).

**No device wraps:**
- `prepareKeys` builds `wraps: []`, adds password + recovery, has no `deviceKey`, and runs `validateKeyring`.
- No `src/` file imports `createKeyring` any more. It is still exported, unchanged, for the test helpers and M1.
- `enableMasterPassword` still requires `hasDevice` (the legacy upgrade path only).
- Session storage holds the unlocked VK only in non-"always" modes, as before. The "shared" e2e test asserts there is no `sk_session` in `chrome.storage.session`.
- No new diag calls.

**Binding:**
- `prepareKeys({vaultId})` → `keyring.vaultId` → the password and recovery AAD (`sixkey-wrap|1|method|vkId|vaultId|kdf`) and the envelope header.
- `restoreBackup` refuses a `vaultId` mismatch (S4 killed).
- The AAD test shows moved wraps do not open.
- A malformed backup `vaultId` fails in `prepareKeys`, before a code is shown.

**Policy:** the floor is enforced in the service (S8 killed); the 50-bit check lives only in the UI (F2).

**The "shared" user is not locked out:**
- The answer is saved before the key, and the session starts after the write.
- `RoutedSession` puts the key in the page's memory.
- The wizard never calls `location.reload()`, and step 4 runs in the same page.
- S2 and U7 are killed.
- After a later reload the user needs the password they just set, which is not a lockout.

**Legacy vaults:**
- The popup notice is kept (`noPasswordNotice`).
- The rail shows a warning and the `#rail-set-password` link.
- `enableMasterPassword` is unchanged.
- The e2e uses a seeded Phase 0 generation.

## 4. Wizard UI: what I checked

**The user cannot finish without confirming the code:**
- Steps run strictly file → password → code → risk → clipboard.
- `#fr-finish` exists only on the risk step.
- `#recovery-done` stays disabled until `#recovery-saved` is ticked.
- Mutations U1 (checkbox gate removed), U2 (code step skipped) and U4 (vault written before the code is confirmed) are all killed.

**The panels are not reachable on an empty install:**
- `#add`, `#add-scanned` and `#backup` all land on the wizard.
- A pending `sk_scan_text` cannot add anything.
- U5 is killed.

**Exposure:**
- The code is in the DOM only on the code step, and the handle is dropped after commit.
- Passwords are cleared from state after `prepareKeys`.
- No `console`, `localStorage` or auto-copy; copy and download are user actions, as before (SECURITY.md already describes the copy left on the machine).
- No new storage keys besides the existing `sk_settings`.

**i18n:**
- 25 `fr*` keys, the same set in both languages.
- `welcomeStart` is removed, and `noPasswordNotice` is kept.
- The overrides are declared.
- The i18n tests ("every key exists", "no dead text", placeholder counts) pass.
- The ZH question matches ux-study §2.8 verbatim.

**Accessibility:** the native radios sit in a `radiogroup`, labels wrap their inputs, errors use `role="alert"`, and the ready banner uses `role="status"` (Appendix D). See F8 for the gaps.

**One screenshot is misleading.** In `shots/en-3-risk.png` both radios look selected. It was taken immediately after `.check()` while the 0.12–0.15 s CSS transitions were running. That is a screenshot artifact, not a defect.

## 5. Test migrations (Appendix A plus the implementer's extras), checked one by one

Method: diff each file against the pre-patch tree, count test cases and `expect`s, and judge the intent.

- No test case was removed.
- No file lost an `expect` (service.test 75→141, import-backup 34→36, store-misc 11→15, residue 6→18; all others unchanged).
- The 27 old call sites match H-c: service 16, import-backup 2+4 restore, enable-crash 2, write-read-mismatch 2, platform/clock/session/purge/store-misc 1 each, plus merge 1 restore.

| Test | Migration | Verdict |
|---|---|---|
| service.test "a new vault needs a master password first" (6) | `createProtected`. "Refuses over existing" now uses a second prepared handle | **Stronger**: `passwordProtected: true`, no `deviceKey`, wraps exactly password + recovery |
| service.test "turning on the master password", "a crash right after…" | `legacyDeviceVault(w.store())` | Unchanged |
| service.test "password changes and key rotation" | Legacy + enable kept ("3 previous" unchanged); new: a native vault rotated twice has 2 previous | Unchanged, plus a new case |
| service.test auto-lock (3), recovery visible (1), lock every time (2) | `createProtected` | Unchanged |
| import-backup (2 create, 4 restore) | `prepareKeys(STRONG,{vaultId})` | **Stronger**: protected, no device material |
| platform, write-read-mismatch, session, purge (`unlockWithPassword`) | `createProtected` | Unchanged |
| clock, merge, store-misc | Shared `MemorySession` (otherwise a password vault is locked in later instances); store-misc races two prepared handles | Unchanged (fixture only); store-misc adds the restore-vs-start-over race |
| enable-crash (2 sites) | `legacyDeviceVault` | Unchanged (see I5) |
| flows "master password: turn on…" | `seedLegacyDeviceVault`. The device key still reaches slot b, a snapshot, the keyring copy and the mirror before it is scrubbed; there is one fewer seeded snapshot than before | Unchanged in intent |
| flows "lock every time", "resetting the password" | Enable step removed; the code comes from `startFresh` | Unchanged |
| flows "encrypted backup restores a fresh install" | Welcome → `#start-restore` → wizard; "2 rows, code right" kept, `#backup-error` still asserted | Unchanged |
| flows language (implementer extra) | New button text, and the wizard heading instead of the Security heading on the settings page | Unchanged in intent (it still proves the page follows the choice) |
| residue 1 | `startFresh` | Unchanged; now trivially empty, but the control in case 2 keeps the scan honest |
| residue 2 | `seedLegacyDeviceVault`, plus a **control**: the scan finds device material in both `Local Extension Settings` and `IndexedDB`, and `attack()` recovers GitHub | Stronger |
| residue 3, 4 (new) | Restore into a fresh profile; start over after unreadable data. No device material, no `attack()` hit, no seed | New (the H1 acceptance test) |
| ui-misc (implementer extra) | Unlock on the skewed page (31 days is past the 15-minute idle limit) | Unchanged in intent: the trash is still offered and never erased by the clock, then survives a reload |
| create-crash (new) | Four scenarios × every write × before/after | New |
| firstrun.spec (new, 6 cases) | All four plan cases, plus restore from "lost" and two tabs | New |

**The residue scanner is meaningful (proved by mutation):**
- S1b (restore writes a device-wrapped keyring) makes residue case 3 fail.
- S1c (restore first writes device-wrapped, then re-keys and scrubs, so the device material exists only as overwritten LevelDB bytes, which is the H-a scenario) also makes residue case 3 fail.

So the scan catches overwritten residue, not just live values.

## 6. Mutation results (each applied alone to the scratch copy, then reverted)

Service mutations ran against the full vitest suite (M1 sync and contract tests excluded). UI and residue mutations ran `npm run build:e2e`, then the listed spec.

| # | Mutation | Result | Killed by |
|---|---|---|---|
| S1 | `prepareKeys` starts from `createKeyring` (a device wrap and `deviceKey` in every new vault) | Killed | service, import-backup, create-crash, session tests |
| S1b | Device wrap only when preparing for a restore | Killed | service "restoreBackup and startOver write no device material…", import-backup, create-crash; **e2e residue case 3** |
| S1c | Restore writes device-wrapped first, then re-keys and scrubs (only overwritten residue left; the H-a scenario) | Killed | store-misc races, create-crash; **e2e residue case 3** (the scanner finds overwritten LevelDB bytes) |
| S2 | H5 preset saved after `committed()` | Killed | "'shared or automated'… still unlocked", "'only me'…", create-crash |
| S3 | H5 preset saved after the write, before the session | Killed | create-crash ("the answer is never missing from a vault that exists") |
| S4 | No vault-id check in `restoreBackup` | Killed | "restoreBackup refuses keys prepared for another vault id" |
| S5 | Handle spent before the write commits | Killed | "a refused write does not spend the handle…" |
| S6 | No `startOver` recheck inside the lock | Killed | store-misc "unreadable data: 'Restore' … and 'Start over' …" |
| S7 | No `create` recheck inside the lock | Killed | store-misc first-run race, "a second setup page that loses the race…" |
| S8 | No `requirePolicy` in `prepareKeys` (weak password accepted) | Killed | "prepareKeys refuses a weak password and writes nothing" |
| S9 | Preset saved before the in-lock recheck (the loser changes settings) | Killed | "a second setup page that loses the race changes nothing…" |
| S10 | Handle never spent after commit | Killed | "a handle is spent once its write commits…" |
| S11 | `create` allowed over "lost" (both guards removed) | **Survived** | — (F3) |
| S12 | No `restoreBackup` recheck inside the lock (restore over unreadable data without the guard) | Killed | store-misc restore-vs-start-over race |
| S13 | `startOver` allowed in any state | Killed | "startOver is refused unless the stored data is unreadable" |
| S14 | Only a stray `deviceKey` field added to the keyring | Killed | service "create leaves no device key…", "restoreBackup and startOver write no device material…", import-backup, create-crash |
| U1 | `#recovery-done` enabled without the "saved" checkbox (finish without confirming the code) | Killed | firstrun "'only me'…", "unreadable data, then 'Restore'…" (harness `toBeDisabled`) |
| U2 | Code step skipped (password → question) | Killed | 5 of 6 firstrun cases |
| U3 | 50-bit strength gate removed from `canPassword` | **Survived** | — (F2) |
| U4 | Vault written right after `prepareKeys`, before the code is confirmed | Killed | firstrun "…leaving the wizard early writes nothing" and three others |
| U5 | Panels rendered on an empty install unless the hash is `#setup*` | Killed | firstrun "a new install has no way to add an account…" |
| U6 | "Type DELETE" gate removed before start over | **Survived** | — (the gate is unchanged from Phase 0 and was never tested; info) |
| U7 | Page saves the preset after `create` (the plan's order reversed) | Killed | firstrun "'shared or automated'… still unlocked" |
| U8 | No `beforeunload` prompt while keys exist | **Survived** | — (F4 / I2: add a Playwright `dialog` test if the prompt is meant to be a guarantee) |

Totals: 24 distinct mutations. **20 killed, 4 survived** (S11, U3, U6, U8). Only S11 and U3 touch A1's own guarantees.

## 7. The implementer's open risks, rated

| Risk | Rating | Blocks |
|---|---|---|
| Misleading "changed in another page" after a landed write | **Medium** (F1); it pushes the user to discard a live recovery code | **Yes** |
| Settings answer left after a failed write | Low (F10); harmless on "empty" or "lost" | No |
| Code lost on a confirmed leave | Low (I2, F4); disclosed by `frCodeNote` | No |
| Prepared keys in page memory | Info (I1); within the A10 scope | No |
| Cosmetic step wrap | Cosmetic: even the four create steps wrap "4 First account" onto a second line at a 1180 px window (`en-3-risk.png`), and restore has five | No |

## 8. Fixes, in order

1. F1: idempotent "the existing vault is mine" check, plus session before spend; add the two probes as tests. **Before merge.**
2. F2: e2e assertion that `#fr-next` stays disabled for `Password12345!`.
3. F3: unit test that `create` over "lost" refuses and writes nothing.
4. F7, F4: disable Cancel while busy; lock the language selector while the wizard is up.
5. F6, F8, F9: small UI and accessibility follow-ups; F5 on the integrator's checklist.

## Appendix P: probes behind F1 and F2

The file is `test/regression/zz-review-probe.test.ts` in a patched copy. Run it with `npx vitest run test/regression/zz-review-probe.test.ts`. All three tests pass on the patch as submitted, which is what demonstrates the bugs. After the F1 fix, the two F1 tests should be inverted: the retry succeeds and the session is started.

```ts
import { describe, expect, it } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionData } from "../../src/core/service/types";
import { checkPasswordPolicy } from "../../src/core/crypto/password-policy";
import { measure } from "../../src/ui/strength";
import { STRONG } from "../helpers/vaults";

/** The slot write lands, then the read-back of that slot throws once (a passing I/O error). */
class ReadBackFails implements KV {
  armed = false; fired = false;
  constructor(readonly inner: MemoryKV) {}
  async get(k: string[]) {
    if (this.armed && !this.fired && k.includes(KEYS.slot.a)) { this.fired = true; throw new Error("io error on read-back"); }
    return this.inner.get(k);
  }
  async keys() { return this.inner.keys(); }
  async set(items: Record<string, unknown>) { await this.inner.set(items); if (KEYS.slot.a in items) this.armed = true; }
  async remove(k: string[]) { return this.inner.remove(k); }
}
class SessionSetFailsOnce extends MemorySession {
  failed = false;
  override async set(d: SessionData) { if (!this.failed) { this.failed = true; throw new Error("session storage failed"); } return super.set(d); }
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e) => `${e?.name}:${e?.code ?? e?.message}`);

describe("F1: a write that landed, then a retry", () => {
  it("(a) read-back throws after the slot landed", async () => {
    const mem = new MemoryKV();
    const settings = new KvSettingsStore(mem);
    const svc = new VaultService({ store: new VaultStore({ kv: new ReadBackFails(mem) }), session: new MemorySession(), settings });
    const keys = await svc.prepareKeys(STRONG);
    expect(await outcome(svc.create(keys))).toBe("Error:io error on read-back");
    expect(await outcome(svc.create(keys))).toBe("ServiceError:bad_state"); // the page shows frChanged: "Nothing was changed here"
    const fresh = new VaultService({ store: new VaultStore({ kv: mem }), session: new MemorySession(), settings });
    await fresh.unlockWithRecoveryCode(keys.recoveryCode); // yet the code the page calls worthless opens the vault
    expect((await fresh.currentGeneration())!.keyring.vaultId).toBe(keys.vaultId);
  });
  it("(b) startSession fails after the commit", async () => {
    const kv = new MemoryKV();
    const svc = new VaultService({ store: new VaultStore({ kv }), session: new SessionSetFailsOnce(), settings: new KvSettingsStore(kv) });
    const keys = await svc.prepareKeys(STRONG);
    expect(await outcome(svc.create(keys))).toBe("Error:session storage failed");
    expect(await outcome(svc.create(keys))).toBe("ServiceError:bad_state"); // handle already spent in committed()
    await svc.unlockWithRecoveryCode(keys.recoveryCode);
  });
});

describe("F2: the 50-bit rule lives only in the page", () => {
  it("Password12345! passes the service floor at 21.6 bits and makes a vault", async () => {
    expect(checkPasswordPolicy("Password12345!").ok).toBe(true);
    expect((await measure("Password12345!")).ok).toBe(false); // 21.6 bits
    const kv = new MemoryKV();
    const svc = new VaultService({ store: new VaultStore({ kv }), session: new MemorySession(), settings: new KvSettingsStore(kv) });
    await svc.create(await svc.prepareKeys("Password12345!"));
    expect((await svc.status()).state).toBe("unlocked");
  });
});
```
