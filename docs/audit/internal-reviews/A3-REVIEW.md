# A3 (H3 verifyPassword + H6 local security log, service layer) review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading, repository paths updated to the current layout and absolute local paths
> shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Scope: `phase0x/A3/A3.patch` (6 files: `security-log.ts` new, `service.ts`, `runtime.ts`, two new
> test files, `service.test.ts`). Review only: nothing in the main tree was changed except this file. The main tree is
> byte-identical to the patch's `base/` (`diff -rq` of `src/` and `test/`), and the patch applies cleanly
> (`patch -p1 --dry-run`). Scratch copies, all under
> `scratchpad/`:
> - `a3-review/`: patched, used for full verification. It also holds the reviewer's probes,
>   `a3-review/extension/test/unit/zz-a3-probe.test.ts` (11 tests that record current behaviour, all pass).
> - `a3-base/`: unpatched, for the size and read-count comparison.
> - `a3-mut/`: mutants. The runners are `a3-mutants/run.py` (whole suite per mutant) and `a3-mutants/run2.py`, with
>   results in `a3-mutants/results.json`. The proposed tests are in `a3-mut/extension/test/unit/zz-a3-fixtests.test.ts`.
>
> Line numbers refer to the patched files.

## Verdict

**MERGE AFTER FIXES.** The service-layer design is sound:
- `verifyPassword` leaves the session alone.
- The log never enters a transact, never touches `sk_events` or the marker, and an append can never fail what it
  records.
- The read gates are unchanged.

The required fixes are small:
- **A3-3**: add the tests that pin rules the patch states but does not test. 9 real mutant survivors; seven tests that
  kill all of them are ready in the scratch copy.
- **A3-1**: either gate `clear()` (and the use of `ack()`) on the master password in A3, or write that rule into C7's
  acceptance criteria before C7 starts.

Everything else is Low or Info.

| Severity | Count | IDs |
|---|---|---|
| High | 0 | |
| Medium | 1 | A3-1 |
| Low | 6 | A3-2, A3-3, A3-4, A3-5, A3-6, A3-7 |
| Info | 6 | A3-8 to A3-13 |

**Top 3**
1. **A3-1 (Medium).** `SecurityLog.clear()` and `ack()` need nothing: no unlocked vault, no password.
   - A colleague at a shared browser is the very adversary H3 and H6 exist for (SYNC-DESIGN item 62). They can guess
     export passwords, then press the (C7) reset button.
   - The count drops to 0 and the popup never tells the owner. The settings page renders its panels while locked, so
     this works from a locked browser too (probe P5).
2. **A3-3 (Low, blocks as a test gap).** 9 plausible bugs survive the package's tests:
   - a checksum typo in a recovery code counted as a guess (the common typo; only a wrong-length code is tested);
   - the same on the reset path;
   - `service.test.ts:881` checks the wrong log (`w.log` instead of `l.log`);
   - `ack()` and `clear()` running without the lock;
   - the runtime's lock name and its local-only wiring;
   - `verifyPassword` accepting the recovery code;
   - a failed key operation still recording.
3. **A3-2 (Low).** `ack()` sets the count to 0 instead of subtracting what was shown. A wrong guess made between the
   popup reading "3" and acking it is never reported (P3). It should be fixed together with A3-1, because C7 builds
   on this API.

## Verification (scratch copy, patched)

- `npm run verify`, exit 0, 5 min 34 s:
  - typecheck clean;
  - 982 tests passed, 1 skipped;
  - build and check-dist OK;
  - e2e 72 passed.
  - This matches the implementer's claims.
- Popup gzip, check-dist's own number:
  - base 54.4 KB (static 45.6 + zh_CN catalog 8.9);
  - patched 55.5 KB (static 46.6 + 8.9).
  - So A3 adds 1.1 KB (A3-7).
- Read counts, base and patched measured separately, **identical** in count and in bytes:

| Path | Unit gate `read-budget.test.ts` (limit) | Real browser `perf.spec.ts` (limit) |
|---|---|---|
| Open, unlocked | 4 (4) | 4 before the first code (4), 6 in all (6) |
| Lock screen + password unlock | 7 (8) | 7 before the first code (8), 9 in all (9) |
| Unlock with IndexedDB failing after a key change | 10 (8 + 2 = 10) | not measured |

- Bytes:
  - open: 42281 B up to the first code, 42577 B in all;
  - unlock: 84414 B up to the first code, 84710 B in all.
  - These are the same in both trees. A wrong password, a recovery-code unlock and `verifyPassword` do read and write
    the log, but no gate measures those paths (A3-9).

## Findings

### A3-1 (Medium): the log's reset and "seen" need nothing, so the alert can be erased by the adversary it targets

**Where:**
- `security-log.ts:173` (`ack`) and `:186` (`clear`);
- `runtime.ts:27` exposes them as `rt.security` with no gate;
- the service holds only `SecurityRecorder.append` (`service.ts:62`), so there is no gated way to clear.

**Failing sequence:**
1. The vault is unlocked in a shared profile ("session" or "idle" mode) and the owner steps away.
2. A colleague opens Settings › Backup and tries 20 passwords through `verifyPassword` (C6). The log records 20
   `unlock_failed` entries and `failed` becomes 20.
3. The colleague presses the C7 card's reset button, which calls `rt.security.clear()`: `failed: 0`, and the entries
   become `[log_cleared]`. Calling `ack()` instead (for example a card that marks itself seen when shown) leaves all 20
   entries but sets the count to 0.
4. The owner's next unlock shows no "N wrong passwords" notice. Only a settings card the owner may never open still
   says "cleared at 14:05".

Probe P5 calls `clear()` directly on a **locked** vault after 10 wrong guesses at the lock screen, and the count is 0:
the service layer itself has no lock check. The UI path follows if C7 puts the reset button on the Security panel,
because `options/App.tsx` renders every panel, the Security panel included, while locked.

**Why it matters:** the H6 text says the log is "an alert line, not evidence: someone with a copy of the profile can
edit it". A two-click reset by someone with no copy, no devtools and no password is a much weaker adversary than that,
and it is exactly the scenario of SYNC-DESIGN item 62, where H3 and H6 are listed as the fix.

**Fix (preferred, in A3, about 15 lines):**
- Add `VaultService.clearSecurityLog(password)`:
  - it calls `verifyPassword(password)` first, so a wrong password is recorded and refused;
  - it allows the clear on `not_protected` (a Phase 0 device-key vault has no password, and anyone at it can open the
    vault anyway);
  - then it calls `clear()`. This means widening `SecurityRecorder` with `clear`, or giving the service the
    `SecurityLog`.
- Write down the C7 contract:
  - only the popup's post-unlock notice may call `ack`;
  - the settings card shows the count but never acks by being viewed;
  - the card's reset uses `clearSecurityLog`.
- A weaker alternative: keep `clear()` open, but have the popup notice also report "the security log was cleared at T"
  when a `log_cleared` entry is newer than the last ack.

**Blocks merge:** yes. Either of two things satisfies it:
- the gated `clearSecurityLog(password)` lands in A3 (preferred);
- or the integrator writes the rule into C7's acceptance criteria before C7 starts. Nothing calls `clear` or `ack` yet,
  so A3's code is not wrong today.

### A3-2 (Low): `ack()` zeroes the count instead of subtracting what was shown

**Where:** `security-log.ts:173-180`. It writes `failed: 0` whatever has been added since the page read the count.

**Failing sequence (probe P3):**
1. 3 wrong guesses.
2. The popup reads `failuresSinceAck() = 3` and shows "3".
3. Another page records a 4th.
4. The popup acks, and the count is 0.
5. The 4th guess is never announced. It is only listed among the card's entries.

**Fix:** `ack(seen: number)`, which writes `failed: Math.max(0, cur.failed - seen)` and keeps `ackAt`. C7 passes the
number it displayed.

**Blocks merge:** no. Do it together with A3-1, because C7 builds on this API.

### A3-3 (Low; blocks merge as a test gap): rules the patch states that no test pins

**Evidence:** the reviewer's mutation run (26 mutants, whole suite each, details below) left 9 real survivors.
`a3-mut/extension/test/unit/zz-a3-fixtests.test.ts` holds 7 proposed tests. They pass on the patched tree and kill
all 9 (checked with `run2.py`).

| Survivor | What it means | Proposed test |
|---|---|---|
| 7 | A recovery code with a bad checksum (a typo of a well-formed code, the common case: 12 check bits) is counted as a guess at the lock screen. The rule "not even well-formed is a typo, not a guess" (`security-log.ts:37`) is tested only with `"not a code"` (`recovery_length`, `service.test.ts:763`). | `[7, 7b]` with `0000-0000-0000-0000-0000-0000-00VN` (`recovery_checksum`) |
| 7b | The same on the reset path: a malformed code becomes `wrong_secret` and is counted. | same test |
| 7d | `verifyPassword` over a lost store records a wrong password. The test meant to catch this checks the wrong log: `service.test.ts:881` reads `w.log` after calling `l.svc.verifyPassword`. | `[7d]`, or change `w.log` to `l.log` at `:881` |
| 10 | `ack()` without the lock races `append`. Entries are lost, or the count is wrong. | `[10]` (needs a slow KV to open the window) |
| 11 | `clear()` without the lock: entries appended before the clear reappear after it. | `[11]` |
| 9 | `runtime.ts` builds the log without `webLock("sixkey-security-log")`. In Node, `webLock` falls back to a per-context mutex, so no unit test can tell. P8 shows that two contexts without a shared lock lose 10 of 20 entries. | `[2, 9]` stubs `navigator.locks` and checks the lock name |
| 2 | The runtime puts the log on the mirror when there is one. The wiring test passes `mirror: null`. | `[2, 9]` with a mirror |
| 13 | `verifyPassword` also accepts the recovery code. H3 asks for the master password; nothing pins it. | `[13]` |
| 15 | A key operation that fails still records (for example `newRecoveryCode` while locked records `recovery_code_new`). | `[15]` |

**Fix:** add these tests (or equivalents), and fix the `w`/`l` typo. **Blocks merge:** yes (cheap; the tests are
written).

### A3-4 (Low): the empty string counts as a wrong password in one prompt and not in the other

**Where:** `service.ts:434` turns `empty_password` into `wrong_secret` and records it. The lock screen
(`unlockWith`, `service.ts:346`) lets `empty_password` through as a different error and records nothing (probe P9).

**Sequence:**
1. C6's export button is enabled with an empty field (or the user presses Enter on it).
2. One `unlock_failed` entry is recorded and the count goes up, although no guess was made.
3. The same keystroke at the lock screen records nothing and shows another error.

This contradicts the patch's own rule ("a typo, not a guess"). It is no oracle: the empty string is never the
password, and the same fast reply comes back for every empty submission.

**Fix:** pick one behaviour for both prompts. Preferred: `verifyPassword("")` rejects with `wrong_secret` without
recording, as the malformed recovery code does. The package's test at `service.test.ts:834` expects five entries,
the empty string's included, and pins the current behaviour (it kills the reviewer's mutant 19), so update it with the
fix. Alternatively, have C6 disable the button on an empty field and document the asymmetry.

**Blocks merge:** no.

### A3-5 (Low): a committed key change is not recorded when the session write after it fails

**Where:** `service.ts:581-582`, `:603-604`, `:510-512`, `:531-533`. Each `record()` runs after `startSession`.

**Failing sequence (probe P4):**
1. `changePassword(old, new)` commits.
2. `session.set` throws.
3. The call rejects, so there is no `password_changed` entry.
4. The new password works and the log does not say it changed.

The same happens to `key_rotated` and `password_enabled`, where the scrub is skipped too. That part is older than A3
and is finished at the next unlock.

**Fix:** record once the commit has happened, whatever follows, for example
`try { await this.startSession(vk); /* scrub */ } finally { await this.record(kind); }`, guarded so that it runs only
after the transact resolved. The log has its own key and its own lock, so writing it between the commit and the
marker's removal cannot affect the marker protocol. "The log write is the last write"
(`security-log-crash.test.ts:194`) is a property the test imposes, not one the protocol needs. Relax it to "alone,
and after the commit" if the record moves.

**Blocks merge:** no.

### A3-6 (Low): a log from a newer version silences this version, and a damaged one reads as a clean "0"

**Where:**
- `security-log.ts:76` (`v > 1` gives `"newer"`);
- `:132-135` (`append` skips);
- `:153-158` (`read()` returns `{ entries: [], failed: 0 }` for a damaged log and for a newer one).

**Sequence (probe P6):** `sk_security_log = { v: 2, entries: [] }` is left by a later version and the extension is
rolled back, or someone with write access plants it. From then on no wrong password is recorded (only a diagnostics
line each time). The card would show "0 wrong passwords" and an empty list as if all were well. A damaged value reads
the same way until the next append replaces it.

**Fix:** have `read()` return `state: "ok" | "damaged" | "newer"` so that C7 can say "this record cannot be read"
instead of showing 0. The leave-alone behaviour for `newer` itself is fine; this version cannot be downgraded through
the store.

**Blocks merge:** no. It is cheapest now, since C7 consumes `read()`.

### A3-7 (Low): popup budget, +1.1 KB gz against +0.4 KB planned

**Measured:** 54.4 KB on base, 55.5 KB patched (static 45.6 to 46.6 KB; the implementer's own figures say +1067 B).
That is about 2.7 times the plan's A3 line (appendix C). The whole `SecurityLog` class (parse, trim, read, ack, clear, diagnostics strings, the kinds list) and
`verifyPassword` / `recordExport` sit in the shared chunk, because `runtime.ts` builds the log for every context.

**Headroom:** only C6 (+0.3, mostly the options chunk) and C7 (+0.6) are still to come. The planned total is about
56.4 KB of 60, so this does not threaten the gate today, but it spends margin M2 will want.

**Optional fix:** the popup only needs `append`. Put a small append function in the shared chunk, and the
reading/acking/clearing side in a module only the options page imports. The saving was not measured.

**Blocks merge:** no. Record the real number in the integration log.

### A3-8 (Info): `verifyPassword` is not write-free on a damaged store

**Where:** `service.ts:426` goes through `store.load()`. Probe P1 corrupts the active slot. `verifyPassword(STRONG)`
then writes `sk_active`, `sk_slot_b` and `sk_events` (a `slot_fallback` event). The plan text says it "不写任何库键"
(writes no vault key).

**Judgement: acceptable.**
- These are the writes `status()`, `read()` and `methods()` already make on the same page. They run under the vault
  lock and follow FIXa2 (the slot the pointer names wins on a keyring difference).
- `recover()` never writes the marker, nothing is overwritten on account of a read that threw, and the event is a true
  one the user should see.
- C6 calls `read()` immediately afterwards anyway, and that call would make the same repair.
- **A3 adds no new data-loss path.** One existing double-fault case is reachable from every `load()`, this one
  included:
  1. The slot the pointer names is damaged.
  2. The other slot holds a key change that never committed.
  3. `named` is then `null` (`store.ts:199-200`), so the FIXa2 guard does not fire.
  4. `recover()` commits that keyring, whose recovery code was never shown.
  - `status()`, `read()` and `methods()` reach it just the same. That case is A2's concern (FIXa2 scope), not a
    finding against A3.
- A read-only variant would need a non-repairing load in `store.ts`, which is A2's exclusive file. The code comment
  states the repair honestly (`service.ts:418-419`).
- **Action:** amend the plan's A3 text ("writes no vault key on a healthy store; on a damaged one, the same repair as
  every open").

**Blocks merge:** no.

A tampered KDF parameter never reaches `verifyPassword`. `checkGeneration` validates the keyring, so the slot reads as
damaged and the check runs against the recovered good copy (P12). That is why mutant 7c, which swallows every
`CryptoError`, is unreachable rather than a gap.

### A3-9 (Info): `recovery_used` is recorded before the vault is opened

**Where:** `service.ts:352`. Probe P7: opening the vault after a correct recovery code fails (here, the settings read
throws), and the log still says `recovery_used`.

**Judgement: the right order.** Knowledge of the code was proven whatever storage did next, and recording first gives
whoever holds the code no window to avoid the entry. Two follow-ups:
- the kind's description (`security-log.ts:39`, "the recovery code unlocked the vault") should say "the recovery code
  was accepted";
- the recovery-code unlock now takes the log's lock and does a get and a set before the view appears. No gate measures
  that path. It is rare and cheap, but say so next to the read-budget test.

**Blocks merge:** no.

### A3-10 (Info): wording, and what D must carry into PRIVACY and SECURITY

- `security-log.ts:6-8` and `:13`: "It never leaves this device" and "This device's history".
  - The intended users run antidetect browsers that sync or export whole profiles, `chrome.storage.local` included,
    so the log travels with the profile.
  - Say "this browser profile; Sixkey never sends, mirrors or exports it".
- `service.ts:336-337`: "the read budget has no room for it" is only half true. The unit unlock gate has one read to
  spare (7 of 8); what is full is the real-browser unlock "in all" count (9 of 9) and the degraded-mirror unlock
  (10 of 10). Name those.
- `PRIVACY.md` does not mention the security log yet. Plan §D.2 gives that to D. Carry these points:
  - local only, times and kinds only;
  - not in backups, the mirror or the diagnostics export (verified: `Misc.tsx:104` exports events and `sk_diag` only);
  - travels with a synced profile;
  - "Clear" leaves one line with the time it was cleared;
  - anyone who can write the profile (a copy, malware, or devtools on an unlocked browser) can edit or silence it
    (A3-6).
- `SECURITY.md` (§D.1): add that H6 is an alert, that its reset is (after A3-1) behind the master password, and the
  gap in A3-12.

**Blocks merge:** no. The code comments can be fixed with A3-3; the documents belong to D.

### A3-11 (Info): deviations from the plan text, all justified, needing sign-off or a plan-text update

1. Format: a `failed` counter was added to `{ v: 1, entries, ackAt? }`.
   - It makes the count independent of the clock and of the 50-entry cap (a burst of 200 guesses counts as 200).
2. Eviction: the plan says "drop the oldest"; the code drops the oldest entry of the larger half (guesses against
   everything else).
   - So 200 wrong guesses cannot push out the record of an export, which is the H-b failure sequence #3 repeated
     inside the log.
3. Three kinds beyond the plan's nine: `password_enabled`, `recovery_used`, `log_cleared`.
4. No `{ failedSince }` from the unlock, and no ack inside it. The plan's A3 text asks for both; this is C7's open
   question below.
5. `security?: SecurityRecorder` (an interface with `append`) instead of `SecurityLog`. That is fine, but A3-1 needs
   `clear` on it.
6. A3-8's repair writes.

**Blocks merge:** no (record them in PHASE0X-PLAN A3 and C7).

### A3-12 (Info): the notice appears only at an unlock, so guesses made while unlocked wait

In "session" and "idle" modes the popup usually opens already unlocked. Wrong export passwords tried through
`verifyPassword` at an unlocked browser (the H3 scenario) surface only at the next unlock (idle timeout or browser
restart) or on the settings card. This applies to every C7 option. Z4 says "解锁后提示一次" (shown once after unlock),
so the spec is met.

D should document it. If the owner wants more, the only change that fits the gates is outside A3's scope: after one
wrong `verifyPassword`, lock the session, so the owner's next unlock shows the notice. That contradicts the current
"a wrong check locks nothing" test and is a product decision.

**Blocks merge:** no.

### A3-13 (Info): new recovery codes wait for the log write

`rotateKey`, `enableMasterPassword`, `resetPasswordWithRecovery` and `newRecoveryCode` `await this.record(...)` before
returning the new recovery code. A rejection is swallowed, but a log write that never settled would keep the code from
the UI after the old one stopped working. This is theoretical: chrome.storage and `navigator.locks` settle, and the
log's lock covers only one get and one set. No change is needed. Keep the log's critical section that small (never put
PBKDF2 or vault I/O under `sixkey-security-log`).

**Blocks merge:** no.

## C7's open question: the "N wrong passwords" notice and the read gates

**Facts (measured above):**
- unit gate: unlock 7 of 8, degraded-mirror unlock 10 of 10, open 4 of 4;
- real browser: unlock 7 of 8 before the first code and 9 of 9 in all; open 4 of 4 and 6 of 6;
- a full log is at most 2405 bytes (P11).

**Option 1: read `rt.security` after the view has rendered, only after an unlock in this popup.**
- Before the first code: unchanged (7). Open: unchanged (4 / 6).
- The real-browser unlock "in all" count becomes 10 against 9. It needs that one allowance raised, with the reason
  written next to it.
- The unit gate's measured path does not change.
- If C7 slipped and read the log on every open (a `useEffect` in `Main`), the existing real-browser open "in all"
  gate (6 of 6) would most likely fail, provided the read lands inside the spec's measuring window. That is a useful
  tripwire, but it should not be the only guard (condition (c)).

**Option 2: read inside `unlockWithPassword` and return `failedSince` (the plan's A3 text).**
- Before the first code: 8 of 8. That uses up the last read of headroom before M2.
- Real-browser "in all": 10 against 9. The unit degraded-mirror case: 11 against 10.
- So it raises two allowances and adds the read before the first paint.
- Its only gain, a read and ack in one locked step, is the wrong semantics anyway: an ack before the notice is on
  screen loses the count if the popup closes within a second.

**Option 3: show it only on the settings card.**
- No budget cost, but it fails Z4 and C7's text and e2e ("the popup shows '3'").
- It makes H6's alert reach the owner only if they open Settings, which they rarely do.

**Recommendation: Option 1, as the owner leaned, with these conditions:**
- **(a)** The read runs only in the unlock-success path, after `setScreen(view)` (App's `unlocked` callback). Never in
  `loadScreen`, `openView` or on `Main` mount.
- **(b)** Raise only `perf.spec.ts` `READS.unlock.all` from 9 to 10, with the reason "one read of `sk_security_log`
  after the first code, only after an unlock, for the C7 notice". Leave `unlock.firstCode` (8) and the open limits
  (4 / 6) as they are.
- **(c)** Add a deterministic unit measurement of that read to `read-budget.test.ts`, so that it is counted somewhere
  other than e2e. Use a separate case; do not fold it into the degraded allowance.
- **(d)** Ack only after the notice has been displayed, with `ack(seen)` (A3-2).
- **(e)** Reset only through the password-gated clear, and the card never acks by being viewed (A3-1).
- **(f)** In "lock every time" mode every popup open is an unlock, so each such open costs one read after the paint.
  That is acceptable, since the first code is not delayed.
- **(g)** Amend C7's acceptance text in the same decision. It says the read gates "必须保持不变" (must stay
  unchanged), which Option 1's raised `READS.unlock.all` cannot meet. Otherwise C7 will be reviewed against a rule it
  cannot satisfy.

**Security reasoning:**
- Where the read happens changes nothing an attacker can do.
- What matters:
  - the notice is tied to a password-proven unlock, so whoever sees it knows the password;
  - nobody without the password can zero the count (A3-1);
  - a popup closed early cannot lose the count (d).
- Option 1 meets all three at the lowest budget cost.

**Rejected alternatives:** folding the log into a get that already happens.
- Into `loadView`'s meta get: `store.ts` is A2's exclusive file, and it would couple the store to the log.
- Into `KvSettingsStore.getView()`: it couples settings to the log, and moves up to 2.4 KB in front of the first paint.

## Mutation testing (reviewer's own set, independent of the implementer's 27)

Each mutant is one exact text change in `a3-mut/`, then `tsc --noEmit`, then the **whole** vitest suite (unit, fault
and regression, `read-budget` included) with `--bail 1`. The copy was diffed against the patched tree afterwards:
identical except the reviewer's added test file.

**Score:** 26 mutants. 14 killed by the package's tests; 12 survived. Of the 12: 2 equivalent or unreachable (6b,
7c), 1 an ordering choice that is not a bug (14), and 9 real gaps (A3-3). The 7 proposed tests kill all 9.

| # | Mutant | Result |
|---|---|---|
| 1 | `changePassword` records inside its transact, before the commit | killed (crash test: "the log alone and last") |
| 1b | `newRecoveryCode` records inside the lock | killed (crash test) |
| 2 | runtime puts the log on the mirror | **survived**; killed by the proposed `[2, 9]` |
| 3 | `clear()` keeps the counter | killed |
| 4 | `verifyPassword` calls `touch()` on success | killed (SpySession) |
| 4b | `verifyPassword` returns early when already unlocked (any password passes) | killed (SpySession) |
| 5 | `unlockWith` appends without `record()`'s try/catch | killed ("a recorder that rejects") |
| 5b | `SecurityLog.append` rethrows non-quota errors | killed |
| 6 | eviction drops the newest of the larger half | killed |
| 6b | tie-break `>=` to `>` | survived, **equivalent**: parse caps at 50, plus one is 51, so there is never a tie |
| 7 | a bad-checksum recovery code counted at the lock screen | **survived**; killed by `[7, 7b]` |
| 7b | the same on the reset path, becoming `wrong_secret` | **survived**; killed by `[7, 7b]` |
| 7c | `verifyPassword` swallows every `CryptoError` | survived, **unreachable** from storage (P12) |
| 7d | `verifyPassword` records on a lost store | **survived** (test checks `w.log`); killed by `[7d]` |
| 8 | append treats a failed read as damaged and overwrites | killed |
| 9 | runtime without `webLock("sixkey-security-log")` | **survived** (untestable in Node without a stub); killed by `[2, 9]` |
| 10 | `ack()` without the lock | **survived**; killed by `[10]` |
| 11 | `clear()` without the lock | **survived**; killed by `[11]` |
| 12 | the wrong-password record is not awaited | killed (crash test) |
| 13 | `verifyPassword` also accepts the recovery code | **survived**; killed by `[13]` |
| 14 | `recovery_used` recorded after `finishUnlock` | survived; an ordering choice, not a bug (A3-9) |
| 15 | `newRecoveryCode` records even when it fails | **survived**; killed by `[15]` |
| 16 | an entry carries one more field (timezone offset) | killed |
| 17 | a newer-version log is replaced by `append` | killed |
| 18 | a reset recorded as `password_changed` | killed |
| 19 | `verifyPassword("")` not recorded | killed (it pins A3-4's current behaviour) |

The brief's eight categories map to these mutants:
- append inside a transact: 1, 1b;
- log in backups or off local storage: 2. The backups themselves are built from the `Vault` object only; the
  package's test checks the encrypted file and a merge of it.
- clear not resetting the counter: 3;
- `verifyPassword` touching the session: 4, 4b;
- swallowed errors rethrown: 5, 5b;
- eviction dropping the wrong side: 6, 6b;
- non-guess refusals counted: 7, 7b, 7c, 7d, 19;
- a read error wiping the log: 8.

## Probes (`a3-review/extension/test/unit/zz-a3-probe.test.ts`, all pass, so each describes current behaviour)

| | Behaviour |
|---|---|
| P1 | `verifyPassword` over a damaged active slot writes `sk_active`, `sk_slot_b` and `sk_events`. It writes no marker and no log entry (A3-8). |
| P3 | `ack()` after "3" was read zeroes a 4th guess (A3-2). |
| P4 | A committed `changePassword` whose session write fails has no `password_changed` entry (A3-5). |
| P5 | 10 wrong guesses at a locked vault, then `clear()`: the count is 0 (A3-1). |
| P6 | A `v: 2` log stops every later entry and reads as `{ entries: [], failed: 0 }` (A3-6). |
| P7 | `recovery_used` is recorded although opening then failed (A3-9). |
| P8 | Two contexts with separate locks lose 10 of 20 entries (why the runtime's lock matters; A3-3 #9). |
| P9 | `verifyPassword("")` is recorded and gives `wrong_secret`; the lock screen's `""` gives `empty_password` and is not recorded (A3-4). |
| P10 | The recovery code is refused by `verifyPassword` (`wrong_secret`, counted). |
| P11 | A full log is 2405 bytes of JSON. |
| P12 | A keyring with tampered iterations never reaches `verifyPassword`: the slot reads as damaged, recovery picks the good copy, and the check passes against it. |

## The review questions, in order

**(1) verifyPassword.**
- **Side effects.** None on the session or the lock state. `SpySession` sees zero calls, the lock epoch is unchanged,
  and "a wrong check locks nothing" holds. It works while locked and in "lock every time" mode, with the key in another
  page's memory. Both are tested.
- **Failure path.** Uniform. Every wrong input gives `ServiceError("wrong_secret")` with the message `wrong_secret`,
  and each one is recorded. The extra log write on the wrong path reveals nothing the answer does not.
  - The empty string skips PBKDF2. It can never be the password, so its speed tells nothing; but see A3-4.
  - A non-unwrap `CryptoError` cannot come from a validated keyring (P12).
  - The PBKDF2 runs while no lock is held, so a check never blocks another page's vault operations. That is better
    than `changePassword` and `rotateKey`, whose KDF runs inside the transact (older than A3).
- **`load()`.** It repairs a damaged store (A3-8): acceptable, and it adds no new data-loss path (the existing
  double-fault case is A2's). The repair is under the vault lock
  and serialised with every transact and with `finishKeyChange`, follows FIXa2, and never writes the marker.
- **Phase 0 device-key vault.** `not_protected`, nothing written (tested).
- **Lost store.** `bad_state`, nothing recorded. True, but the test for it checks the wrong log (A3-3, 7d).
- **No rate limiting.** Defensible. It is the same oracle as the lock screen, at one PBKDF2 (600k) per guess. Anyone
  who can run code in the extension can read the keyring and attack offline much faster. A delay kept in one page is
  gone by opening another. F23 rejects lockouts because they slow no one with a copy and become a way to lock the
  owner out. Recording every guess is the right substitute.

**(2) The log.**
- **Crash safety.** One get and one set of its own key under its own lock. Torn, before and after crashes are modelled
  at the log write for 11 operations, with the marker invariants checked at every write. A read that throws writes
  nothing (tested, mutant 8).
- **Concurrency.** Appends from several contexts are safe under `navigator.locks`. The lock wiring and `ack`/`clear`
  are untested (A3-3).
- **Lock hold time.** The lock is never held across PBKDF2 or vault I/O. `diag()` is fire-and-forget, so
  `wrong_secret` waits only for one get and one set.
- **Eviction and `failed`.** Sound (A3-11 #1, #2). The counter is trivially editable by anyone who can write the
  profile. That is acceptable for an alert line, but needs wording (A3-10) and the gated reset (A3-1).
- **Versioning.** "Newer" is left alone, but the UI needs the state (A3-6).
- **Size.** Bounded, at most 2.4 KB.
- **Damaged values.** Read as empty and replaced by the next append, with a diagnostics line.
- **`log_cleared`.** Consistent with "user-clearable": one dated line remains, and it can age out after 25 later
  non-guess entries. Say so in PRIVACY (A3-10).

**(3) Where entries are appended.**
- **Never inside a transact.** `guarding` wraps the transact, so the record runs after its lock is released; the crash
  test pins this.
- **Never inside the marker window**, on the success path: after `scrubQuietly` clears the marker. If the scrub fails,
  the record lands while the marker is set, which is harmless (different key, ignored by `staleIn` and `orphans`).
- **Failure swallowing.** It is total: `SecurityLog.append` and `VaultService.record` both catch, and an append failure
  cannot change a result or leave the vault inconsistent (tested with a dead KV and a rejecting recorder).
- **Ordering.** `recovery_used` before `finishUnlock` is right (A3-9). A key change whose session write fails is not
  recorded (A3-5).

**(4) Read gates.** Unchanged in count and bytes (table above). The C7 recommendation is above.

**(5) Tests.**
- Strong where they exist: the crash matrix, the read-free success unlock, H-b isolation, backups, ways to a vault, and
  the runtime wiring.
- Weak in the 9 places of A3-3. The implementer's claims were reproduced: 982 tests, 72 e2e, build and check,
  55.5 KB.

**(6) Privacy.**
- **Entries.** Exactly `{ at, kind }`: the stored keys are checked, and a parse drops anything else.
- **Kinds.** Fixed and validated, so `recordExport("<anything>")` adds nothing and the diagnostics line does not echo
  the string.
- **Diagnostics.** The messages are fixed strings, and `createDiagLogger` stores only the error's `code` or `name`.
  The diagnostics export (`Misc.tsx:104`) contains events and `sk_diag`, not the security log.
- **Errors.** `ServiceError` and `CryptoError` messages are codes or fixed text. No password, code, account name, IP
  or user agent appears in the log, in diagnostics or in an error on any path.
- **Test.** `service.test.ts` checks that the password strings appear nowhere in storage or diagnostics.

## Checked and found sound

- No nested locks:
  - `record()` always runs outside the vault lock;
  - the log's lock covers one get and one set;
  - `verifyPassword` holds no lock during PBKDF2.
- The log never reads or writes `sk_events`, the slots, the pointer, `sk_keychange` or `sk_store_v`: the spy test lists
  the keys touched, and no `kv.keys()` listing is made. `hasAnyData`, `orphans` and `staleIn` ignore it. A store
  holding only the log is "empty".
- `create`, `restoreBackup`, `startOver` and `importBackup` keep the log as it was (tested). Backups and the mirror
  never contain it.
- The 50/50 eviction keeps the newest 25 of each half. The count is exact and independent of the clock.
- Damaged input is read safely:
  - unknown kinds, non-finite times and extra fields are dropped;
  - a hand-made 500-entry list is cut to the newest 50;
  - a bad count is recounted from the entries after the last ack.
- The wrong-guess definition is right where tested:
  - malformed codes are typos;
  - `weak_password` comes before any guess, so it is not recorded;
  - `not_protected` and `bad_state` are not recorded.
- A successful password unlock and the next open do not touch the log (tested with a counting KV), so the popup's read
  budget is untouched.
- `verifyPassword` checks the keyring as stored now, not the session's key. After a rotation in another page, the next
  `read()` still refuses a stale session.

## Closing verdict

**MERGE AFTER FIXES.**
- **Required:**
  - A3-3: add the 7 proposed tests and fix `service.test.ts:881`;
  - A3-1: either the gated `clearSecurityLog(password)` in A3, or a written C7 acceptance item.
- **Recommended with A3-1, since C7 builds on this API:** A3-2 (`ack(seen)`) and A3-6 (`read()` reports damaged or
  newer).
- **C7 notice:** Option 1 with conditions (a) to (g).
- **Counts:** High 0, Medium 1, Low 6, Info 6.
- **Top 3:** A3-1 (an ungated reset erases the alert for the very adversary H6 targets), A3-3 (9 surviving mutants,
  including a test that checks the wrong log), A3-2 (`ack` zeroes guesses that were never shown).
