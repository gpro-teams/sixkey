# M6C review: the `server_older_key` repair, find accounts, the dedupe after an approval join

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "Independent" removed from
> the reviewer line. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and
> were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the
> test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

Security review of `M6C.patch` (scratchpad `m6c/M6C.patch`, 32 files), applied to a copy of the live repo
at `m6c-review/tree/`, with `python3 scripts/messages.py` run. Line numbers below are in the patched tree. Read against
`docs/SYNC-DESIGN.md` rev. 25 (§3.5, §3.9, §3.10, §3.14, §4.2, §4.3, §5.8, D6, O13), `docs/design/notes/M6-NOTES.md` and
`docs/design/notes/M6C-NOTES.md`.

**Verdict: merge after fixes.** One blocker (B1). Its fix is four lines, and it closes a gap part B already had. The
design is sound in most places:

- keeping the adopted auth on the repair is correct;
- the repair never changes local keys or data;
- find accounts sends nothing in plaintext and writes only through `mutate`;
- the dedupe only ever moves entries to the trash.

**The re-revoke decision (§1 item 4): keep it, but change where its list comes from (M1).** As built, it reads a list
that is stale in the Sync section's own "lost" flow. Two probes show a stolen device getting the newer keys, or the
vault, after the repair.

## Ranked findings

| # | Severity | Finding |
|---|---|---|
| B1 | **Blocker** | The repair never checks the "current password" before sending. A typo poisons the server's password verifier, and every device then loses pw_auth: revoke, rotate and change password stop working. |
| M1 | **Major** | Re-revoke reads `state.devices`. That list does not hold the revocation right after the UI's own "lost" flow, and a device on `needs_password` never refreshes it. The stolen device then gets VK2, or reads the vault. |
| m1 | Minor | Dedupe race between two approval joins with the same account: both copies go to the trash, no live copy is left anywhere, and the notice says "the extra copies are in the trash". |
| m2 | Minor | Re-revoke inside the repair: no in-page list of the devices it will revoke. The revocations keep going after a lock. Its "device removed" notice is lost on a crash. A network error there shows the repair's "unconfirmed" screen. |
| m3 | Minor | "The head stays in the server's history / 30-day history" is overstated. §5.8 keeps the newest 30 versions plus each day's last one. |
| m4 | Minor | Find accounts shows issuer and label only, so some rows look the same as a live account (a renamed one, an old secret). It also cannot tell versions crafted under a previous key. |
| m5 | Minor | The dedupe key ignores type, algorithm, digits, period and counter, so the join's copy with the right parameters can be the one trashed. |
| m6 | Minor | A "join unfinished" re-join, which takes the merged path, clears `joinAdded`. The duplicates then stay, although the summary promised the trash. |
| m7 | Minor | During `server_older_key` the device list cannot decrypt names, because they are under VK1. That makes the residual's advice ("revoke it again from the list") hard to follow. |
| m8 | Minor | Text: two ambiguous zh/en strings, `syncNoticeDeletedDanger` still pointing only to a backup, empty and uncapped source lists, and one sentence in `local-vault.md` that needs to be completed. |
| m9 | Minor | Tests: the revoke test and the crash matrix use an order the UI never runs. Missing tests: the wrong current password, two joins, and the join-commit window of the record. |

---

## B1 (blocker): the repair's "current password" is never checked before the send

`extension/src/core/sync/engine/keys.ts`:
- **Line 827:** the pre-send check opens the server's bundle with `oldPassword`.
- **Lines 831–836:** the recovery code is checked against the local keyring.
- **Line 863 (older-VK branch) and line 883 (same-VK branch):** both compute `password_verifier` from `o.password`. Nothing opens the local keyring with `o.password` before the request.
- **`published()` (`crypto/presend.ts:204`):** the first place that notices, which is after the server has answered 200.

**Scenario**
1. The restore crossed a password change. The user types the old password correctly in "Master password the server's keys use, if different", and makes a typo in the first field.
2. Or the user types the old password in the first field and leaves the second empty (`repair.ts`: `oldPassword: o.oldPassword || o.password`).

**What happens** (probe `probes/m6c-probe-repair-password.test.ts`; log `probes/probes-on-m6c.log`):
- `POST /v1/keys/rotate 200`. The server now holds keyring2 with a password_verifier for a password that does not open it.
- `repairKeys` throws `SyncCryptoError invalid_argument`, and the page shows a generic failure.
- A's next round is `ok`, so nothing looks wrong.
- B's `revokeDevice` with the right password fails with `password_mismatch`, which the page shows as "wrong password". "Emergency revoke is never blocked" (§3.14) is broken for every device.
- The only way out is a recovery-code reset. The probe shows that it works, but nothing points the user to it.

**Scope**
- M6C sends both verifiers on every older-VK repair, so the gap is always open there.
- Part B's same-VK repair has the same gap whenever the wraps differ (the second probe test, `PUT /v1/keys 200`). That gap is pre-existing.

**Fix** (`probes/R1-fix.diff`). Next to the recovery-code check:

```ts
const byPw = await unlockWithPassword(local, o.password).catch(() => null);
if (!byPw || byPw.id !== c.cur.vk.id) throw new KeyOpError("wrong_secret");
```

- It cannot regress a repair that works today. `published()` already requires `o.password` to open the sent keyring, so the
  check only refuses, before the send, what would fail anyway after the server had accepted.
- `wrong_secret` is in `FIXABLE`, so the form stays open with "wrong password".
- With this fix, both probe tests pass, and so do `m6c-older-key`, `m3-repair`, `m3-keys`, `m3-scenarios`, `m6-manage` and `m6c-crash-repair`.
- Optionally, record the failed attempt like the other adoption forms do (§3.9, "输错照常记录").

---

## M1 (major): re-revoke reads a device list that misses the revocations that matter

`keys.ts:906–924` (`revokeAgain`) revokes the devices that `sk_sync_state.devices` marks as revoked and the restored
server lists as active. That list is written only by `engine.ts:1081 refreshDevices`, which is called from
`engine.ts:599` (after the key check at 583–586) and from `engine.ts:825` (after the pinned check at 817–820). Two gaps
follow.

### (a) The Sync section's own "lost" flow never records the revocation

`options/sync/revoke.ts:147–188` runs, in order:
1. `prepareRotation`, whose round runs before any revocation;
2. `noteRotationOwed`;
3. `revokeDevice`, which does not touch `state.devices` (`keys.ts:1020–1029`);
4. `commitRotation`, which runs no round unless the head moved.

So right after the flow, A's stored entry for X is `{"revoked": false}`.

Probe `m6c-probe-rerevoke-order.test.ts`, test 1, in the UI's order with an honest restore before A's next round:
- the repair sends no revocation (`revoked_at = null`);
- X, with the master password, adopts VK2 (`X holds the newer key: true`).

The M6C unit test (`m6c-older-key.test.ts:249–251`) and the crash matrix (`m6c-crash-repair.test.ts:37–39`) revoke
first and rotate afterwards. `prepareRotation`'s round then records the revocation, which the UI never does.
M6C-NOTES §1 says "the 'lost' revocation's own rotation runs one first". That is wrong for this order: the round runs
before the revocation.

### (b) A device on an intermediate key never sees the revocation at all

A device in `needs_password` returns at step 2 (`engine.ts:583–586`) before `refreshDevices`.

Probe test 2:
1. VK1→VK2 is a routine rotation that B and X take.
2. A revokes X as lost and rotates to VK3.
3. B stays on VK2 (`needs_password`) and keeps editing locally (R4).
4. The server is restored to VK1. B shows `server_older_key` and repairs.
5. X is not revoked. Its round is `ok`, and it reads B's account added after X's revocation (`X reads B's later account: true`). X needs no password here, because it already holds VK2.

Profiles that are rarely opened sit in `needs_password` for weeks. In multi-profile setups, which this product targets,
this is the case where it matters.

### The windows

- (a) lasts until this device's next round: minutes in practice.
- (b) lasts until the device adopts the newer key: unbounded.
- Both also need an honest restore whose restore point predates the revocation.

M6C-NOTES §6 says, unconditionally, "a device revoked as lost does not get them back through the repair".

### Fix

Keep the step and change where its list comes from (sketch: `probes/R2-fix-engine.diff` and `probes/R2-fix-keys.diff`):

1. **On revoke:** `revokeDevice` marks the id as revoked in `state.devices` as soon as the server says 200.
2. **Sticky:** `refreshDevices` never turns a known `revoked: true` back to active. Revocation is monotonic per device id, and only a restore undoes it.
3. **Refresh order:** refresh the list at step 1, before the key checks, as §4.2 step 1 says. That covers the `needs_password` and locked rounds, so (b) learns the revocation. Because of (2), a `server_older_key` round then stores the restored list without losing what was revoked.

Results:
- With 1–3, both probe tests pass.
- All 70 non-probe files in `test/unit/m3*`, `m5*` and `m6*` pass.
- So do the M3 fault matrices: `m3-crash-round`, `m3-faults`, `m3-model`, `m3-crash-keys`, `m3r3-review-crash` and
  `m3r4-review-crash` (35 tests), and `m6c-crash-repair`.
- `tsc` is clean.
- Cost: a failed `GET /v1/devices` now also fails rounds that used to stop at `needs_password`.

Also recommended:
- Show the restored server's active devices in the repair form, with names decrypted with the previous VK (see m7).
- Say there: "devices removed before the restore are removed again: …; if you removed another one since, remove it again first."
- Better still, record when the server held a key this device never had (`needs_password` before the restore), and have the card say "repair from a device with the newest keys" instead of offering the repair. That stops the partial VK2 republish in (b).

### On the decision itself

- **Keep it.** Without it, every honest restore across a "lost" revoke-and-rotate hands the stolen device the newer keys, given the password.
- **The ordering is right:** every revocation goes out before the rotate, and a refusal stops the repair.
- **It is not atomic:** a revocation that was sent stays in effect. That is the safe direction.
- **A malicious server gains nothing from it.** It can only make the device revoke ids the server itself once reported as revoked, and it can revoke any device itself anyway. It can also replay a genuine old bundle to show `server_older_key` at will. It still learns nothing new: the same keyring2, envelope, K_write2 and verifiers it already had, and a pw_auth under the old bundle's genuine auth. The kver only goes up.

---

## m1: dedupe race, two approval joins with the same account

Code: `sync-flows.ts:589` (`trashJoinDuplicates`), run from `engine.ts:536/757`. A join's copy goes to the trash when
any live twin outside its own record exists. When two profiles B and C joined with the same account Z, each counts the
other's copy as the twin.

**Probe** (`m6c-probe-dedupe-race.test.ts`):
1. B's first PUT lands with its answer lost (`offline`), so B's record is kept.
2. C's round trashes C's copy, and its rerun's PUT fails.
3. B's next round sees C's copy alive and trashes B's copy.
4. At rest, all three devices show `alive [Mail]` and `trash [Z, Z]`.

**Impact:**
- Nothing is erased: the trash has no expiry, and the notice links to the trash.
- But an automatic step takes a 2FA account out of every list, and the notice says the opposite of what happened.
- The other way into the same state is a lock right after B's upload ("join dedupe waits"). The plain concurrency window between C's two passes also leads there.

**Fix** (`probes/R3-fix.diff`): a total order every device computes the same way. A recorded copy goes only if a live
twin outside the record comes before it by `(createdAt, id)`.

```ts
const before = (x: Entry, y: Entry) => x.createdAt < y.createdAt || (x.createdAt === y.createdAt && x.id < y.id);
... if (key === null || !others.some((t) => addedModeKey(t) === key && before(t, e))) continue;
```

- The worst case left is a duplicate that stays alive, never zero copies.
- The synced vault's original normally predates the join's copies (`createdAt` is the join time), so the normal case is unchanged.
- Every device computes the same order. `clampVault` never touches `createdAt`, and `mergeEntry` takes the minimum
  (`vault/merge.ts:65`), so an id's `createdAt` converges.
- A skewed clock only changes which copy comes first, not that exactly one comes first.
- With the fix, the probe passes, and so do `m6c-dedupe`, `m6-approval` and `m6c-crash-dedupe`.

---

## m2: re-revoke inside the repair, its edges

- **No in-page confirmation of the revocations.** M6-NOTES lists "revoking" among the destructive actions confirmed in the page. Re-applying a revocation the user already confirmed is defensible, but the form says nothing about it. It needs one line listing the devices: the VK1 names can be decrypted.
- **It ignores a lock.** `keys.ts:917–922` revokes with the pw_auth computed before the lock and never re-checks that the vault is open. `revokeDevice` itself (`context` → `openVault`) refuses when locked. Add `await stillOpen(e, c.cur.vk.id)` before each revoke.
- **Its notice is lost on a crash.** The notice is written after the loop (`keys.ts:923`). A death after a revocation and before the notice leaves X revoked, and the retried repair finds nothing to revoke, so the user is never told. Write it per revocation, or before the loop.
- **Its network errors use the wrong screen.** `apiOp` turns them into `unconfirmed`, which `RepairFlow` shows as "The server's answer didn't arrive. Sixkey checks again shortly." The rotate was never sent, and nothing will check again.
  - Not `offline` either: a revocation whose answer was lost may already be in effect.
  - Use a code of its own: "a revocation's result is unknown; the repair's keys were not sent". The card stays up, so a retry is safe.

## m3: what the server's history really keeps

M6C-NOTES §1 item 6 says the restored head "stays in the server's history". O13 and the UI speak of "30 days of
history".

§5.8 (`api/server/sixkey_server/retention.py`) keeps the newest 30 versions plus each UTC day's last version, for 30
days, within 64 MiB. A restored head that is not its day's last version is pruned after 30 later uploads, which can
mean the same day on a busy account. So "Nothing is lost by leaving it out" holds only for data that a living device
still holds locally.

State the bound in the notes and in `local-vault.md` when it gains its sync section.

## m4: find accounts, what the list cannot show

Code: `core/sync/engine/find.ts:140–154`, `ManageViews.tsx:835ff`.

Each row shows issuer and label only:
- A live account that was renamed and lives under another id (an old vault's snapshot, or one that was re-added) is offered as "missing". Bringing it back makes a duplicate with the same secret.
- An old GitHub entry with a since-replaced secret looks exactly like the live GitHub entry.
- A version under a previous key can be written by any holder of that key, a revoked device for instance, with a malicious server's help. Its fake accounts look the same as real ones.

This is a pre-existing residual (§4.3 R5 allows such versions here). Nothing leaks: the fake secret is the attacker's,
and plaintext never leaves the device.

Suggestions:
- Mark versions under an older key ("before the key change of …").
- Flag a row whose secret matches a live account, or whose issuer and label match a live account with another secret.

What was checked and is fine:
- Every server version is decrypted only with a held key, and its vault id is checked.
- Parsing goes through `deserializeVault`.
- The edit is re-checked inside `mutate` and goes through the outbox.
- Duplicates within a version are collapsed.
- An erased id is never revived.
- The plans live in a WeakMap and are dropped on Back, on another version, on the edit, and on any end.
- A lock ends the flow at once, unless the edit is under way.
- Permission is asked first, in the click.
- A server-supplied error code passes `IDENT` and falls back to the generic text.

## m5: what the dedupe key ignores

`addedModeKey` (`vault/ops.ts:100`) is the secret plus the lower-cased issuer and label. It ignores type, algorithm,
digits, period, group, domains and counter. When the two copies differ, for instance a corrected `digits` on this
profile, the join's copy is the one trashed.

Normalisation: issuer and label are only lower-cased. There is no trim and no NFC, so a copy that differs by whitespace
or by Unicode form (fullwidth, composed or decomposed) is not a match. That errs on the safe side: the duplicate stays
alive and nothing is trashed wrongly.

For HOTP, which generates codes in Phase 1 (§4.12), trashing the copy with the higher counter makes the remaining one
repeat codes the site has already used.

Suggestions: require equal OTP parameters for a match, or keep the larger counter. §3.5 says "secret + issuer + label",
so this is a design note.

## m6: a "join unfinished" re-join clears the record

`sync-flows.ts:558`. A crash after the join's local commit and before `complete` leaves "join unfinished". An approval
re-join of the same vault id then takes the merged path, where `addedIds` is `[]`, so `joinAdded: null` is written. The
duplicates stay alive, although the summary said they would go to the trash.

It fails in the safe direction. Fix: keep an existing record of the same vault id when the join's mode is "merged".

## m7: device names cannot be read during `server_older_key`

`devices.ts:46–58` (`listDevices`) decrypts names with the current VK only, while the restored server's names are under
VK1. The device list then shows unnamed rows exactly when M6C-NOTES tells the user to find the device "this device
never saw" revoked and revoke it again.

Fix: try `unwrapPreviousVks` too.

## m8: text, a11y and docs

**Strings**
- `syncSummaryAddedLater` (`m6.py:143`/`457`) is ambiguous in both languages: it can be read as "the synced vault's accounts go to the trash".
  - en: "…After the first sync, this profile's copy of any account the synced vault already has goes to the trash."
  - zh: "第一次同步之后，同步库里已有的账户，本配置文件的那份会移到回收站。"
- `syncNoticeDuplicates` zh (`m6c.py:27`): "…个账户**在**同步库里已经有了，多出的**副本**已移到回收站。"
- `syncNoticeDeletedDanger` still says "restore from a backup". The notice now offers Find accounts, so add "or find them".

**Lists**
- a11y: each version button's only text is a date or `#n`. Give it context, for instance "Open the version of {date}",
  or an `aria-describedby` that points at its list's heading.
- An empty source list (no snapshots) renders an empty `<ul>` under its heading. Add a "none" line.
- `.sync-find-src` has no cap. A malicious server can list thousands of versions; an honest one lists at most about 60.

**Docs**
- `local-vault.md`'s new section should add one clause. Anyone holding the current vault key can, with the server's help, publish a password wrap of their choosing, and that password then opens the page (§3.9 R2/R3, pre-existing).

**Checked and fine**
- Sizes, from `check-dist --e2e` on the patched tree: sync catalogs en 10.1 KB and zh_CN 11.2 KB gz, under the 12 KB limit, which matches the notes' 10,323 B and 11,436 B. The popup is 56.4 KB, and `m2-source-rules` passes.
- Terminology: 保险库 for the vault and 同步库 for the synced vault, consistent with the existing strings.

## m9: test quality and the crash matrices

**Tests that encode the wrong order**
- `m6c-older-key.test.ts:244–276` and `m6c-crash-repair.test.ts:37–39` build the "lost" case as revoke → round → rotate. They should use the RevokeFlow order: prepare, owed, revoke, rotate. With that order, M1 shows up.

**Missing tests**
- A wrong current password (B1).
- A restore that crosses a password change on the older-VK path, the `old_password_required` route.
- Two approval joins (m1).
- The crash window of the join commit with `joinAdded`, including the "join unfinished" re-join (m6).
- The notice after a crash between a revocation and the notice (m2).

**Matrix coverage**
- The repair matrix has a single revoked device, dies on one device only, and never checks the re-revoke notice.
- The dedupe matrix covers only the joined device's first round.
- Both are otherwise thorough: before and after every step, a browser restart, and the user's way back.

**Wiring**
- `m6-wiring` test 1's `found >= 15` was not bumped for the new start. Cosmetic.

**Mutants**
- The 49/49 claim was not re-run. The probes above are the mutants the suite misses: "no check of `o.password`" survives, and the UI-order variant of "not done again" survives.

---

## What was checked and holds

**The repair (`server_older_key`)**
- **Typed codes:** the recovery code must open this device's keyring.
- **Pre-send check:** it verifies the server's bundle with the VK the previous list really unwraps.
- **Gates:** `not_behind` refuses a second repair. The version gate runs first.
- **What is sent:** this device's vault under its own VK, the write proof under K_write1, `new_write_key` K_write2, and names re-encrypted from VK1 to VK2.
- **Outcome:** judged by the exact bundle MAC, so another device's repair is `changed_elsewhere`.
- **Lock:** the commit carries the epoch read before the last open-vault check, so a lock on the wire leaves the page locked.
- **Local state:** no local key or data changes. Find accounts can open the restored head under VK1.
- **Auth:** keeping the adopted auth is correct. A new salt would leave every device that took the rotation on `auth_without_password` (R2 / F-07). Reusing it gives the same pw_auth and verifier the server held before the restore, so nothing new is exposed. Its salt still differs from the KEK salt, because it was minted by `newBundleAuth` against that same wrap. The design text (§4.2 step 3, "new auth salt") should be corrected, as the notes ask.
- **Head not merged:** a revoked device that is active on the restored head can still reach the synced vault through an honest device that is only on VK1 and merges that head before it adopts. Only added accounts get through; the guard stops changed secrets and erasures. This is already named in the notes and is accepted.

**Find accounts**
- No plaintext leaves the device: only signed GETs and the ordinary upload of the edit.
- It does not overwrite a live entry.
- An entry in the trash comes back with that version's names and settings, and keeps its own secret and its own HOTP counter.

**The dedupe**
- Trash only, never erased.
- The record holds ids only, and is cleared on the first "ok" round with `lastSynced`. Note that `sk_sync_state` is rewritten whole, up to about 195 KB, until then.
- It runs under the sync lock, inside `mutate`, and is re-checked against the vault of that moment.
- Its moves go up in the same `round()` call, through the rerun loop at `engine.ts:173–188`.

## Probes and fix sketches

Probes (in `probes/`; copy them into `extension/test/unit/` to run):

The probes assert the safe behaviour and log nothing, so each file can be adopted as a regression test once its fix
lands.

| Probe | What it shows | On M6C | With the fix |
|---|---|---|---|
| `m6c-probe-repair-password.test.ts` | B1, plus the pre-existing part-B variant | fails, 2 of 2 | passes with `R1-fix.diff` |
| `m6c-probe-rerevoke-order.test.ts` | M1 (a) and (b) | fails, 2 of 2 | passes with `R2-fix-*.diff` |
| `m6c-probe-dedupe-race.test.ts` | m1 | fails | passes with `R3-fix.diff` |

- `probes-on-m6c.log` is the run on the unmodified patch. It comes from an earlier, logging version of the probes, and
  holds the outcomes quoted above.
- `probes-with-fixes.log` is the run with all three fixes applied together: 12 files, 75 of 75 passing. They were the
  probes, `m6c-*`, `m6-approval`, `m6-manage`, `m3-repair` and both M6C crash matrices.
- Each fix was applied to the review tree on its own, then reverted. The tree is back at the patch state (checked with `cmp`), plus the three probe files.
- Commands: `nice -n 19 npx vitest run --maxWorkers=2 <files>`. No e2e was run.
- Baseline on the patched tree: the eight M6C, wiring and source-rule files, 59 of 59 passing.
