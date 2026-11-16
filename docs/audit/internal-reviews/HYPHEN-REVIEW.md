# HYPHEN review: typing a generated master password back loosely

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "Independent" removed from
> the reviewer line and absolute scratchpad paths shortened. Paths under `scratchpad/` were the reviewer's temporary
> working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record
> quotes it or as it was adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md);
> how to read these records: [`docs/audit/README.md`](../README.md).

Security review of `HYPHEN.patch` (stateless tolerance, the `sk_pw_format` input hint, and the grouped
input), applied to a fresh rsync of the live repo (`patch -p1 -E`: clean, then `scripts/messages.py`).

**Verdict: merge after fixes.** The fixes are B1 (a few lines, no catalog bytes, popup +8/−5 B measured) and M2 (docs), plus an owner
decision on M3. M1, the sync engine's exact checks, blocks opening the release gate, not this merge.

Everything below was run under `nice -n 19`, with vitest `--maxWorkers=2` and targeted file lists only; no e2e.

## What was verified

| Check                                                                                                                   | Result                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `tsc --noEmit`: patched tree; enrolment-v2 + this patch                                                                 | 0 errors, 0 errors                                       |
| password-entry, password-entry-service, quick-source-rules, keyring, read-budget, quick-read-budget, m2-source-rules    | 104/104 passed                                           |
| Combined tree (enrolment-v2 + this patch): password-entry ×2, quick-source-rules, enroll-v2, m3-enroll                  | 81/81 passed                                             |
| read-budget-sync, m3-read-budget, backup-subset, import-backup, quick-pin-service, security-log, service (patched tree) | 183/183 passed                                           |
| The probes (P1–P6) on the patched tree; samepw-fix with the B1 fix; `tsc` on the fix tree, probes included              | 6/6 passed; 50/50 passed with the entry suites; 0 errors |
| Patch order: this patch on enrolment-v2, and the reverse                                                                | both apply with no offset and no fuzz                    |
| The implementer's 28 mutants, re-run in a separate copy (`mut-theirs`); M4f/M4g/M9 also on the combined tree            | 31/31 killed                                             |
| 12 reviewer mutants (R1–R11, R4a/b)                                                                                     | all killed; R1, R2, R3 and R5 only by the probes here    |
| Prod builds with check-dist, gate closed and open (numbers in the merge plan below)                                     | check-dist OK for all 4 builds                           |

**What holds (focus 1): no false accept, one extra key derivation at most, one failure per attempt.**

- The second candidate is a pure function of the typed string. A canonical string is a fixed point (property-tested over
  3,000 strings), so an input opens the vault only if one of these holds:
  - it is the stored password after NFKC (as before);
  - the stored password is exactly the generator's spelling, and the input is that spelling with case and separators
    changed.

  Length is exact: R7, "17 symbols cut to 16", is killed. Words are exactly 5, of 3–9 ASCII letters.

- No lookalike is ever mapped (focus 1). The generator never emits I, L, O, 0 or 1 (`CHARS` in src/ui/strength.ts
  equals `GEN_ALPHABET`; a test holds the two equal), and `SYMBOLS` and `NOT_GEN_SYMBOL` exclude all five in both cases.
  A string containing one of them has no candidate at all; it is never "corrected". The BMP sweep in
  password-entry.test.ts checks this, and R8 (mapping 1→J and 0→Q) is killed.
- Case folding: the alphabet has a single case, and a non-Unicode `/i` regex maps no code point ≥ 128 into ASCII, so
  `ı`, `ſ` and the Kelvin sign cannot sneak in through case folding. NFKC runs first, as the key derivation does
  (`kdf.ts normalizePassword`). Characters that NFKC folds to ASCII (full width, `ſ`→s, the Kelvin sign→K,
  mathematical alphanumerics) are therefore already the same password under the key derivation's own normalisation.
- At most two derivations. The second one runs only after `unwrap_failed`; an empty password is still a typo, not
  recorded and not tried twice. One `unlock_failed` and one `failed` count per attempt hold at:
  - the lock screen;
  - verifyPassword and requireMasterPassword (export, clearing the log, a new recovery code, delete forever);
  - PIN set and remove;
  - rotation and password change;
  - sync step 4(b). P5 is new for this one; R5, "recorded twice", survived the patch's own suite.

  The PIN's tries and its set-up are untouched: the master-password path never touches `sk_quick`'s counter.
  `unlockWithPin` reads the hint only as part of the pointer's existing get.

- Timing: the second derivation happens exactly when the typed string has a generated shape _and_ the as-typed attempt
  failed. Both facts are visible to the person typing (the input, and whether the vault opened), so nothing about the
  stored secret leaks. Acceptable.
- Online rate: there is no lockout (F23), so secrets tested per second of PBKDF2 are unchanged. The one change is
  that a security-record entry can stand for two tested secrets. Document it (m5).
- Whatever is derived after a check uses the spelling that opened the keyring: the rotation's new wrap (M8 killed) and
  the first upload's server verifier (M9 killed, on the combined tree too). No set or change path stores a loose
  spelling.

**What holds (focus 2): the hint decides nothing.**

- It is written only after a commit and bound to the wrap's salt.
- A record that is lost, stale (crash between the commit and the write, or a password changed by another page or by
  sync) or forged changes only which field is shown. The unlock repairs it.
- No check reads it (source rules), and the candidates never take it as an input (M5 killed).
- It is read inside the pointer's get, not as a read of its own: the unit read gate asserts `keys[0]` contains it with
  ≤ 4 gets at the lock screen, and read-budget and quick-read-budget pass. The first unlock after the upgrade writes
  it once. That write is the documented exception in `unlockWith`'s comment; the steady state writes nothing (M11
  killed).

## Findings, ranked

### B1 (blocker). The subset export's "not your master password" guard misses loose spellings

**Where.** `extension/src/options/Backup.tsx:108`:
`samePw = asks && subPw !== "" && subPw.normalize("NFKC") === exportPw.normalize("NFKC")`.

**Scenario.**

1. The master password is `JDXT-NBSG-6JQG-XBTV`. The export's master field is now the grouped boxes, so `exportPw` is
   exactly that.
2. For the account file that goes to someone else, the user types the same code from memory: `jdxt nbsg 6jqg xbtv`.
3. The guard sees two different strings. zxcvbn also clears it at the 50-bit rule (probe P4 checks `measure().ok`), so
   the export goes ahead.
4. The recipient now holds a string that opens the vault at every prompt (P4 shows `verifyPassword` and the popup
   unlock accepting it), and the master password itself once they have a copy of the profile.

This is the only same-secret guard in `src/` (grep for `===`/`!==` against old, current or master passwords, and for
`same*`/`reuse` helpers). This guard's whole purpose is "the master password must not be the one they learn". The patch defines loose spellings
as the same password everywhere else, so this guard must use the same definition.

**Fix.** `probes/samepw-fix.diff`: a pure `sameMasterPassword(a, b)` in Backup.tsx that compares
`generatedForm(s)?.canonical ?? NFKC(s)`.

- Cost: no new string. Backup.tsx is not in the popup graph, but the new import of a popup-shared module can re-chunk
  (notes §4 saw that happen with clipboard.ts), so it was measured: the popup is +8 B with the gate closed (60,280)
  and −5 B with it open (61,122). That is gzip noise.
- Completeness: if the user's typed master `M` opens the stored `P`, then every `S` that opens `P` compares equal to
  `M`. This follows from canonical spellings being fixed points and from `C(x)` depending only on `NFKC(x)`.
  `probes/samepw-fix.test.ts` checks it against the real `openWithPassword`, plus a property over random codes. R4a and
  R4b are killed.
- Over-blocking: rare and harmless. A user's own loose-stored code is refused as its canonical spelling too.

**Do not** use a service call that asks "does this string open the vault?" without recording. That would be an
unrecorded password oracle for whoever sits at an unlocked browser, which is exactly who the security record is for. If
a service-side check is ever wanted, make it the export's own call, run only after `verifyPassword(exportPw)` has
succeeded in that same call.

### M1 (major, before the gate opens). The sync engine's key operations still require the exact spelling

**Where.**

- `keys.ts`: the 12 `preSend(e, c, op, { password })` sites at 325, 365, 577, 840, 1050, 1067, 1084, 1131, 1137,
  1149, 1155 and 1177.
- `keys.ts:850`: repair's second password.
- `bundle-eval.ts:40` `openKeyring`, used by `presend.ts:136/141/204` and the join's `decideRemoteUnlock` at
  `bundle-eval.ts:173/176`.
- The approver: `preSendCheck({ secret: { password } })` at `enroll.ts:689`, which approves, responds to or rejects a
  device. Enrolment-v2 rewrites it; it is at `enroll.ts:743` in the combined tree.
- The sync section's own prompts are plain fields.

**Today it is safe, only inconsistent.** A loose spelling is refused on the device: `preSendCheck` opens the server's
MAC-verified bundle locally before deriving any proof. P6 taps every request body at the fake server:

- a wrong password, of either shape, sends zero `password_auth`;
- a loose spelling also sends zero;
- the exact spelling sends exactly one, and it is accepted.

R6, "send an unverified proof", is killed by P6. Keep P6 as a permanent test.

**The hazard of a naive fix (never lose data).** Suppose an engine rotation or password change resolves the spelling
for the proof but builds the new wrap from the typed loose string. The stored password then silently becomes
`jdxtnbsg6jqgxbtv`. The canonical spelling the user saved is never mapped back to a loose one (candidates go loose →
canonical only), so `JDXT-NBSG-6JQG-XBTV` stops working at every prompt. `published()`'s lock-out guard does not catch
this: it is handed the same typed secret, it runs after the server has accepted, and it re-checks with the exact
`openKeyring`.

**Smallest safe fix** (§7.4's design, made enforceable):

1. Add one resolver, `resolvePassword(local, server?, typed): ResolvedPassword`. It returns the spelling that opens the
   **local** keyring (`openWithPassword`). Otherwise it tries the MAC-verified **server** keyring that `GET /v1/keys`
   just returned (still local, and no proof exists yet). Otherwise it returns `typed` unchanged, which is today's
   behaviour, for a password changed elsewhere.
2. Make `ResolvedPassword` a branded string type. `preSendCheck`'s secret, `passwordProof`, every new wrap (`rekey`,
   `setPassword`), `commitPublished` and `published()` require it.
3. Rename each operation's raw parameter to `typed`, so nothing after the resolver can use it. A silent change of
   spelling then fails to compile instead of being caught by a test.
4. A _new_ password (change and repair) stays exact. Resolve only the old or current one. `reconcile.ts:26`
   (`sub.newPassword`) stays exact.
5. One request, one proof. There is no retry loop anywhere that could send a second `password_auth`; the server never
   sees a candidate the device has not verified.
6. Land it after enrolment-v2, which rewrites the approver site in enroll.ts.

**Tests for the fix.** For each operation:

- the loose spelling succeeds with exactly one accepted proof (P6's tap);
- afterwards `unlockWithPassword(keyring, GEN)` (exact) opens the keyring and the loose spelling opens it only through
  the candidates;
- mutants that wrap or derive a proof from `typed` are killed.

Replace the patch's "engine stays exact" assertion (password-entry-service.test.ts, renameDevice with LOOSE) once the
fix lands.

### M2 (major, docs, audit-grade). The new key and the tolerance are missing from the inventories and the threat model

- `docs/PRIVACY.md:33–37`, "For reviewers, the keys": `sk_pw_format` is not listed. The user-facing summary above that
  list needs one line: "if your master password is a generated one: which style, as a hint for the input".
- `docs/ARCHITECTURE.md` §3 table, at `sk_pin`'s row, line 85: add a row for `sk_pw_format`.
- `docs/security/local-vault.md`:
  - the profile-copy row (line 59) should say what the record discloses (see M3);
  - "Master password and first run" (lines 84–89) should state the tolerance, the one extra derivation and one record
    per attempt (m5), and that no stored password is ever a loose spelling.
- No test reads these inventories (grep finds none), so nothing caught the omission. Consider a docs rule that every
  `sk_*` key spelled in `src/` appears in PRIVACY.md.

### M3 (major, owner decision). What the hint tells someone with a copy of the profile

pw-format.ts:8–11 and notes §8.1 say that the record only discloses "the generator's shape, which is public anyway".
That understates it.

1. **Triage.** Presence means "generated, 79.3 or 64.6 bits: skip". Absence means "user-chosen, or not learnt yet:
   attack". For an attacker holding many profiles, this multiplies the offline budget per user-chosen target by
   `1/(1−f)`, where `f` is the share of generated passwords. That is ≤ 1 bit while `f` ≤ ½. Per-target strength is
   unchanged: PBKDF2 at 600k iterations and the 50-bit floor.
2. **Structure of a user-chosen passphrase.** `gen5words-v1` is written by shape, at set time and at every unlock, for
   any lowercase hyphen-joined 5-word passphrase. That is a common human style ("correct-horse-battery-staple-quilt").
   For such a user the record publishes the exact structure: 5 words, a–z, 3–9 letters, `-`. A search for that one
   pattern is a dictionary attack, not a 64.6-bit search.

**"Always write a `user` record" does not help.** Its value carries the same bit, in plain text.

The real options:

- (a) Accept, and correct the two texts above. Acceptable.
- (b) **Recommended.** Keep the hint in `chrome.storage.session` only, learnt at the first password unlock of each
  browser session and folded into that unlock's existing session write. Nothing reaches the disk. After a browser
  restart, the settings unlock bar shows the plain field, which accepts loose spellings anyway; the export, PIN,
  rotation and delete prompts, where re-typing actually happens, get the grouped input.

  Two conditions:
  - It needs a `chrome.storage.session` key of its own that survives soft locks. It must not live inside `sk_session`
    or anything `RoutedSession.clear` empties at a lock; otherwise the unlock bar loses the grouped input at every lock.
  - It changes the read and write patterns, so the read gates must be checked again for it.

- (c) Drop the `gen5words-v1` record. Its only effect in the UI is one helper line, which can be shown or left out
  unconditionally. This removes item 2.
- (d) No stored hint at all: offer the grouped input as a toggle.

File this in OWNER-DECISIONS. Whichever option is chosen, (c)'s point about words stands.

### m1. MasterField swaps the input under the user's fingers

`MasterField.tsx:30` and `App.tsx:73–80`: the hint is re-read on every `storage.onChanged` for `sk_pw_format`. If a
first unlock in another context writes the hint while a settings prompt is half typed, the plain `<input>` is replaced
by the boxes, or the reverse. The typed value carries over but focus is lost. Fix: decide the field when it mounts, or
switch only while `value === ""`.

### m2. Hint reads on the settings page: unordered, and a full load each time

`App.tsx:72` (`void passwordFormat(rt).then(setPwFormat)`): concurrent reads can resolve out of order, so a stale
answer can land last (UI only). Every `reload()` also runs `store.load()` (pointer + slot, under the store lock, so the
cost is reads only) just to get the salt. Fix: sequence the reads with a counter, or have `service.status()`, which
loads the keyring anyway, return the format.

### m3. PasswordGroups: accessibility and input edges

- There is no `role="group"` with `aria-labelledby` on `.pw-groups`. Each box's `aria-label` overrides the visible
  `<label for>`; that is fine, but a screen reader never hears "group" for the set.
- The Show button has no `aria-controls`.
- Auto-advance moves focus on input (WCAG 3.2.2-adjacent). This is common for OTP fields; say so in the notes.
- `pastedCode` treats any paste with ≥ 16 alphabet symbols as a code and takes the first 16. A long password of the
  user's own, pasted under a forged or mismatched hint, silently becomes a wrong 16-symbol try, which is recorded.
- IME composition with Show on: `put()` rewrites `value` mid-composition. This could not be verified without e2e.
  Password-type inputs disable IME in Chrome.
- Masking (`type="password"` unless Show), `autocomplete="off"`, `autocapitalize`/`spellcheck` off, emptying on
  `pagehide` and on a lock from any page, and no storage are all right. Source rules hold them, and M7a–d are killed.

### m4. Doc nits

- `src/platform/runtime.ts:118–122`: `keysChangedElsewhere`'s JSDoc now sits orphaned above `passwordFormat`'s own.
- `src/core/crypto/password-candidates.ts:14` names `test/unit/password-candidates.test.ts`, which does not exist. The
  tests are in `password-entry.test.ts`.

### m5. One record can stand for two tested secrets

This is correct by design: no lockout exists, and the rate per derivation is unchanged. Say it in local-vault.md and
in the security card's help, so that "N wrong attempts" is read correctly.

### m6. Separators (optional)

U+2010–U+2015 (hyphens and dashes) and U+2212 (minus) are not accepted; NFKC folds only U+FF0D. Accepting them is
safe, since they carry no entropy, but it costs popup bytes. Leave it out until the budget allows.

## Tests and mutants (focus 5)

The implementer's suite is good: tables, properties, a sweep of the whole BMP, derivation counting, and real-runtime
service tests.

**Gaps, now covered by `probes/hyphen-review-probes.test.ts`:**

| Probe | What it pins                                                                                                     | Kills                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| P1    | Only a wrong key moves on to the second spelling: any other failure throws at once, after one derivation         | R1 (advance on any error)                         |
| P2    | A record of another `v`, for the very same wrap and format, is no hint                                           | R2 (version ignored)                              |
| P3    | A shaped file password of the user's own, typed exactly, costs one derivation                                    | R3 (no `break`)                                   |
| P4    | Documents B1: passes today, and states what the fix must change                                                  | —                                                 |
| P5    | Step 4(b) with a wrong shaped password: one record, two derivations; with a loose one: accepted                  | R5 (recorded twice)                               |
| P6    | No `password_auth` for a wrong or unresolved spelling; at most one per action, and always one the server accepts | R6 (unverified proof sent). Keep through M1's fix |

`probes/samepw-fix.test.ts` goes with `probes/samepw-fix.diff` (B1) and kills R4a and R4b.

Mutant runner: `scripts/mutants.py`. Log: `mutants.log`. The implementer's table is read from their script unchanged
and run in a separate copy.

**Results: 43 of 43 killed, none survived, every pattern applied.**

| Group                                                  | Mutants                                                                                                                      | Result                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The implementer's (M1a–M18), in this review's copy     | 28                                                                                                                           | 28 killed by password-entry, password-entry-service and quick-source-rules, as claimed       |
| The implementer's M4f, M4g, M9, on enrolment-v2 + this | 3                                                                                                                            | 3 killed: the enable flow's tolerance and verifier survive the rebase                        |
| The reviewer's R1–R3, R5                               | advance on any error; version ignored; no `break`; double record                                                             | killed **only** by hyphen-review-probes (P1, P2, P3, P5): survivors of the patch's own suite |
| The reviewer's R6                                      | pre-send sends an unverified proof                                                                                           | killed by P6, and by password-entry-service                                                  |
| The reviewer's R7–R11                                  | 17 symbols cut down to 16; lookalikes mapped; words' case kept; hint learnt from the typed string; hint for the old password | killed by the patch's own suite (the false-accept ones by password-entry.test.ts)            |
| The reviewer's R4a, R4b (on the B1 fix)                | bare NFKC guard; helper without the generator spelling                                                                       | killed by samepw-fix.test.ts                                                                 |

## Budget and merge order (focus 4)

Gzip sizes, measured with check-dist's method on prod builds in this review (`sizes.log`):

| Build                       | Popup, gate closed | Popup, gate open | Full catalog zh_CN | Sync catalog zh_CN |
| --------------------------- | ------------------ | ---------------- | ------------------ | ------------------ |
| Live (from the notes)       | 59,623             | 60,492           | 12,150             | 11,594             |
| + this patch                | 60,272             | 61,127           | 12,233             | 11,594             |
| + enrolment-v2 + this patch | 60,238             | 61,119           | 12,233             | 11,841             |
| + this patch + B1 fix       | 60,280             | 61,122           | 12,233             | 11,594             |
| Limit                       | 61,440             | 61,440           | 12,288             | 12,288             |

What this leaves:

- **The popup, gate open: 321 B** for everything after both patches.
- **The full catalog: 55 B.** No further string fits.

The B1 fix measured +8/−5 B in the popup (noise) and 0 B in the catalogs; M2 is docs only. M1's resolver lives in the sync engine; measure whether any of it
reaches the popup's shared chunk in a gate-open build. If it does, it has to wait for the popup service split.

**Should this land before the two splits?** Yes, it fits. Nothing that adds text or popup bytes may land after it until
the catalog split is in; `pwsetup.py` and `pwentry.py` are the natural first tenants of the proposed password catalog
(§4).

**Order:**

1. **Enrolment-v2.** It is budget-negative (−34/−8 B in the popup on top of this patch) and adds no full-catalog text.
   The M1 fix must also cover the approver path that enrolment-v2 rewrites (`enroll.ts:743` after it).
2. **This patch, with B1 and M2 fixed.** It rebases with no fuzz, and the combined tree typechecks and passes the shared
   suites. Both patches touch `enroll.ts`, `sync-flows.ts`, `shared.tsx` `Ctx` and `quick-source-rules.test.ts`
   without textual conflict.

   Re-run on the merged tree: password-entry ×2, quick-source-rules, enroll-v2, m3-enroll, the read-budget tests,
   check-dist with the gate both open and closed, and the e2e specs pw-entry, export, perf and quick-pin, on port 18787.

3. **The catalog split.** Nothing that adds text may land before it.
4. **M1, the engine's password resolution**, with P6 kept.
5. **The popup service split**, before any further popup bytes, and in any case before the gate opens. 321 B is not a
   budget.

If enrolment-v2 is not approved yet, this patch can go first. The order is textually free in both directions; only
the M1 fix must wait for enrolment-v2.

## Files

- `scratchpad/hyphen-review/probes/hyphen-review-probes.test.ts`:
  P1–P6, for `extension/test/unit/`.
- `scratchpad/hyphen-review/probes/samepw-fix.diff`
  and `scratchpad/hyphen-review/probes/samepw-fix.test.ts`:
  the B1 fix and its test.
- `scratchpad/hyphen-review/scripts/mutants.py`
  and `scratchpad/hyphen-review/scripts/sizes.sh`:
  the mutant runner and the size measurement.
- Logs, in
  `scratchpad/hyphen-review/`:
  `mutants.log`, `sizes.log`, `vitest-targeted.log`, `vitest-combined.log`, `tsc-hyphen.log`, `tsc-combined.log`.
- Trees, in the same folder: `tree/` is the live repo with this patch, `rev/` is enrolment-v2 with this patch, and
  `fix/` is this patch with the B1 fix.
