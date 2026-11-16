# PWUX-r2 review: "Generate for me", passphrases, known entropy

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "independent" removed from
> the reviewer line and an absolute local path shortened. Paths under `scratchpad/` were the reviewer's temporary
> working copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record
> quotes it or as it was adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md);
> how to read these records: [`docs/audit/README.md`](../README.md).

Reviewer: a security review of `PWUX-r2.patch` (11 files), applied to an rsync copy of the repo at
`pwux-review/tree/`. The live working tree was not modified. All line numbers refer to the patched tree.

**Verdict: merge after fixes.** The generators and the entropy figures are correct.

- **The registry is safe.** The known-entropy registry cannot be used to get a weak password accepted.
- **One gap remains below the 50-bit bar.** The only way a password under 50 bits gets in is the sub-frame race in m1,
  and the floor still bounds it.
- **There is one blocker.** On the new primary path, the revealed password is written in plaintext to the browser
  profile on disk. That is exactly what the threat model is about.

The blocker's fix is one attribute, and it was measured through the real component. The major item is a small change.

## What was run (all under `nice -n 19`)

- **Setup:** rsync of the repo (with the requested excludes), `node_modules` symlinked, `patch -p1 -E`, then
  `python3 scripts/messages.py` (494 messages).
- **Checks:** `tsc --noEmit` is clean, and the pinned `prettier` 3.9.9 (`extension/node_modules/.bin`) is clean on the
  changed files. `notices.mjs --check` is up to date.
- **Unit tests (vitest, `--maxWorkers=2`):**
  - `password-setup.test.ts`: 30/30.
  - `errors`, `source-rules`, `i18n*`, `m6-i18n`, `notices`: all pass.
- **Prod build and `check-dist.mjs`:** OK. Exact gzip sizes:

  | What                 | Size                                 | Limit    |
  | -------------------- | ------------------------------------ | -------- |
  | popup (static + zh)  | 55,415 + 4,166 = **59,581 B**        | 61,440 B |
  | zh_CN full catalog   | **12,150 B**                         | 12,288 B |
  | en full catalog      | 10,760 B                             | 12,288 B |

  The word list sits in the lazy chunk `assets/dist-*.js` (1.2 MB). Only the options chunk imports it, and only through
  `import()`. No popup chunk references it.
- **e2e:** the project's e2e suite was not run (port 8787). I wrote three standalone Playwright scripts and ran them
  once each against the **prod** `dist/`. They need no API server and no port. Browser: Chrome for Testing
  156.0.8078.4 (Playwright 1.64.1): `probes/disk-probe.mjs`, `probes/ui-probe.mjs`, `probes/lock-probe.mjs`. Their outputs
  are next to them as `*.out`.
- **Mutation checks:** done by hand on `strength.ts`. The file was restored afterwards and checked with `cmp`.

## Verified correct

- **`uniformIndex`** (strength.ts:59–66):
  - **Exactness:** `limit = 2^32 − (2^32 mod n)` is the largest multiple of n that is ≤ 2^32. The test is a strict `<`
    and the result is `% n`, so every residue has exactly `limit/n` preimages. There is no modulo bias.
  - **Termination:** the rejection probability is 4/2^32 ≈ 9.3e-10 for n = 31 and 2560/2^32 ≈ 6.0e-7 for n = 7776.
  - **Draws:** each draw is one `Uint32Array(1)`, so there are no chunking limits. The arithmetic is exact in doubles.
- **Randomness source:** `crypto.getRandomValues` is the only one. When it throws, both generators throw. `Math.random`
  and `Date.now` are never called (probe).
- **Alphabet:** `CHARS` is exactly 31 symbols: the 26 letters minus I, L and O (23), plus the digits 2 to 9 (8).
  - 16 × log2 31 = **79.2671** bits.
  - The floor rejects outputs with fewer than 5 distinct symbols (the `-` is the 6th). That is 1.79e-10 of the space,
    which leaves 79.26714096593 bits.
  - Neither keyboard-row nor run sequences are possible across the 4-character groups.
  - The old `byte % 31` gave 79.235 bits, not the 80 that was claimed.
- **Words:** the list has 7,776 entries, all distinct, `a-z` only.
  - 5 × log2 7776 = **64.624** bits.
  - The floor rejects only phrases whose letters total 4 or fewer distinct ones: 619,692 of 2.8e19 tuples, 2.2e-14. No
    EFF word contains a 6-key keyboard run.
  - Because the separator is unambiguous, the string determines the tuple, so the claim is exact.
- **Registry:**
  - Lookups are exact matches (`Map`, SameValueZero), and only the two generators write to it. Every entry is
    floor-checked and has at least 64.6 bits.
  - None of these lets a weak typed password through: generate → edit → undo, generating twice, copying into another
    field, or an NFKC or full-width variant (that goes to zxcvbn, as the probe shows).
  - `MIN_BITS` is 50 and `MIN_PASSWORD_LENGTH` is 12. `password-policy.ts` is untouched.
  - The floor is still enforced in `service.ts:1026`, `backup.ts:37` and `sync/engine/keys.ts:323,466`.
- **No download control:** `PasswordFields` has none. Every new button is `type="button"`, so implicit submission is
  unchanged.
- **Inputs:** both have `spellcheck={false}`.
- **Logging:** `logError` logs the error code only.
- **Copy:** "16 random characters: about 79 bits" and "5 random words: about 64 bits" are both true (the figures are
  floored).

## Findings

### B1. BLOCKER: a revealed password is written to the profile's session files in plaintext

- **Where:** shared.tsx:231–232 and 266–267 (`type={shown ? "text" : "password"}` with `autocomplete="new-password"`),
  and shared.tsx:142 (`setShown(true)` after Generate).
- **What happens:** Blink saves form-control state for session restore. It skips `type=password` inputs and inputs with
  `autocomplete=off`, but not these. Chrome writes that state to `Default/Sessions/Session_*` and `Tabs_*` as UTF-16LE.
- **Measured** with `probes/disk-probe.mjs`, one fresh profile per variant, scanning every file in UTF-8 and UTF-16LE:

  | Variant                                                          | Plaintext on disk         |
  | ---------------------------------------------------------------- | ------------------------- |
  | A: generated, page navigates away                                | **FOUND** (Sessions, Tabs) |
  | E: generated, a section link (`#hash`), browser closed           | **FOUND**                 |
  | H: generated, nothing else, browser closed                       | **FOUND**                 |
  | G: typed with "Show" ticked (the existing reveal), navigate away | **FOUND**                 |
  | B: tab closed / C: submitted (fields emptied), then navigate     | not found                 |
  | D, I (controls): Show unticked, so `type=password`               | not found                 |
  | F, J (fix): `autocomplete="off"` while shown                     | not found                 |
  | K (fix): fields stay `type=password`, value shown as page text   | not found                 |

- **Why it is a blocker:** a copied profile gives the attacker the master password, or a backup file's password, in
  clear text. The vault's protection is moot. The old Generate and Show did this too, but this patch makes it the
  default, primary path for every user and for backup files.
- **Fix (one line per input):** `autocomplete={shown ? "off" : "new-password"}` on both inputs.
- **The fix was verified through the real component:**
  1. I applied it to shared.tsx:232 and 267 in the scratch tree and rebuilt prod. `check-dist` passed.
  2. I reran variants A, E, G and H. All four came back **not found** (`probes/disk-probe-fixed.out`).
  3. `password-setup.test.ts` and `source-rules.test.ts` still pass (36/36). The only rule that pins the literal checks
     that Backup.tsx has no field of its own, so it is unaffected.
  4. I restored the file afterwards and confirmed it with `cmp`.
- **Alternative:** keep the inputs `type=password` and show the generated value as text in the `-made` box (verified by
  K). The recovery code is already shown as page text (`<span>`s in `RecoveryCodeBox`), so it is not exposed this way.
- **Probe:** adopt the first two tests of `probes/password-setup-probes.spec.ts`.

### M1. MAJOR: generated secrets are kept far longer than needed, and survive a lock

1. **The module registry.** `const made = new Map` in strength.ts:38–44 keeps up to 8 plaintext passwords for the whole
   life of the settings page. That includes the master password and backup-file passwords. Nothing removes them: not a
   successful submit, not an unmount, not a lock. The C6-6 rule ("not left for whoever sits down next") is undone by a
   heap snapshot of a settings tab that is still open.
2. **The component state.** `PasswordFields`' own `made` state still holds the value after the parent empties its
   fields, for example after "Change password".
3. **The backup forms on a lock.** Measured with `probes/lock-probe.mjs`. After a lock, a generated backup-file password
   is still in `#backup-pw`, still `type=text`, with the explanation box and **Copy** still on screen. Backup.tsx only
   empties `exportPw` on a lock (Backup.tsx:67–85). The panels stay mounted under the UnlockBar (App.tsx:203).
   - **Part of this is pre-existing.** The old Generate also revealed the fields, and Backup never emptied `pw`/`pw2`
     on a lock.
   - **What the patch adds** is Copy on that screen, a revealed field as the primary path, and the registry in (1).

- **Fix:**
  - Export `forgetGenerated(value?)` from strength.ts. Deleting can only send strings back to zxcvbn, so it cannot raise
    anyone's bit count, and the "only generators write" rule still holds.
  - In `PasswordFields`: forget the previous value when `made` changes, on unmount, and when `p.value` becomes `""`.
  - On the lock epoch, forget everything (Backup.tsx already has that listener).
  - Backup: empty `pw`, `pw2`, `subPw` and `subPw2` on a lock as well. `PasswordFields`: reset `made` and `shown` when
    its value is emptied from outside.
- **Probes:**
  - `probes/password-setup.probe.test.ts`: "FAILS-NOW: the page can drop what it no longer needs".
  - `password-setup-probes.spec.ts`: "a lock empties and hides a backup file's password".

### m1. Minor: for about one frame after an edit, the parent still acts on the earlier answer, and three write paths never re-check

- **The window:** `p.onStrength?.(null)` (shared.tsx:116) runs in a Preact `useEffect`, which waits for the next frame
  (requestAnimationFrame, or a 35 ms timeout).
- **Measured** (`ui-probe.mjs` staleWindow):
  1. Both fields are set to `Password12345!`, which passes the floor but is under 50 bits.
  2. `#fr-next` is **enabled** after the input event's microtasks.
  3. It stays enabled for about 2 ms, then turns off.
- **Who is exposed:**
  - FirstRun and Reset re-check `measure(pw).ok` before writing, so they are safe.
  - **Security** (enable and change), **Backup** (both exports) and **sync ManageViews** do not re-check. A
    programmatic or assistive click inside that window would store a password that passes the floor but is under 50
    bits.
- **Impact:** the floor still holds and a human cannot hit the window, which is why this is minor. But the notes say "a
  parent never acts on a stale answer", and that is overstated.
- **Fix, either of:**
  - add `if (!(await measure(pw)).ok) throw new ServiceError("weak_password")` to those four handlers;
  - pass the measured value along with the result (`onStrength(r, value)`) and require `value === pw`. `useLayoutEffect`
    alone also narrows the window.
- **Probe:** "the parent's button is never enabled on the answer for an earlier value" (e2e).

### m2. Minor: a generated password pasted back shows the empty-field hint while the button is enabled

- **Where:** shared.tsx:134. The heuristic `s.generated !== (gen !== null) ? null : s` hides the answer whenever the
  field holds a registry string that this instance's `made` does not match.
- **Scenarios:**
  - Generate → Copy → Choose my own → paste.
  - Generate in `backup` → paste into `subset`.
- **Measured:** the line reads "At least 50 bits estimated strength…", **0 bars**, no offer button, while `#fr-next` is
  **enabled**. This contradicts the notes' claim that the meter, the button and the last check always agree.
- **Fix:** keep the value with the answer (`setS({ for: p.value, r })`) and use the answer only when `for === p.value`.
  Drop the heuristic. Show "Generated: N bits" whenever `r.generated` is true.
- **Probe:** e2e "pasted back".

### m3. Minor: a slow passphrase overwrites a password the user typed meanwhile

- **Where:** shared.tsx:135–148. `use()` awaits the word list, then calls `onValue` and `onConfirm` and `setShown(true)`
  without checking what happened in between. "Choose my own" is not disabled while `making`.
- **Measured:** after a style click followed at once by Choose my own, the typed `my own typed password 1` was replaced
  by `underwent-announcer-…`, shown in clear text.
- **The same at a lock:** if the component unmounts during the await (a lock), `remember()` still stores the
  passphrase.
- **Fix:** a generation token in a `useRef`. `own()`, `onInput` and unmount bump it, and `use()` drops its result when
  the token has changed.

### m4. Minor (accessibility): focus is lost, and some changes are never announced

- **Focus** (measured):
  - **"Use a generated password instead"** removes itself (`offer` becomes false), so focus falls to `BODY`.
  - **"Easier to type: words"** disables itself while loading (shared.tsx:216), so focus also falls to `BODY`.
  - **Fix:** after any generation, move focus to the new-password input, or to Copy. Use `aria-disabled` instead of
    `disabled` on the focused button.
- **Announcements:**
  - **"Copied"** is never announced.
  - The **`-made` box** is reached only through `aria-describedby`.
  - **`aria-live="polite"`** reads a whole sentence on every keystroke.
  - **Fix:** put a short `role="status"` region for "Generated / Copied". Consider debouncing the live line, or making it
    live only when the line crosses the bar.

### m5. Minor: Copy leaves the master password on the clipboard indefinitely

- shared.tsx:202 writes the master or backup-file password to the clipboard. From there it can reach OS clipboard history
  and cross-device sync.
- The extension already has a hash-checked clear (`sk-clip-arm`, offscreen/main.ts), used for codes when the optional
  clipboard permission is held. The recovery code's Copy (pre-existing) does not clear either.
- **Fix:** arm a clear when the permission is held, with a longer delay than 30 s so there is time to paste into a
  password manager. Otherwise, add a line of advice.

### m6. Minor (tests): the index into the word list is not tested

- **Surviving mutants:** `list[uniformIndex(Math.min(list.length, 4096))]` claims 64.6 bits but delivers **60.0**, and
  `list.length - 1` never draws the last word. **Both survive all 30 tests.** Membership checks, the chi-square on
  `uniformIndex` alone, and scripted low indices cannot see them.
- **Probe that kills both:** "draw k gives list[k], for indices across the whole list including the last".
- **Remaining gap:** the component's gating and race logic has no unit coverage (the repo has no DOM library). The e2e
  probes cover it.
- **The chi-square tests are sound:** they use seeded draws through the spy, so they are deterministic and not flaky. At
  p ≈ 1e-6 they detect the old byte-modulo bias (statistic ≈ 179 against a limit of ≈ 83). Exact rejection is held by
  the scripted tests.

### Nits

- options.css:691: the comment still says "Copy / Save as file / the other style".
- **Word list and notice:**
  - zxcvbn-ts ships a modified EFF list: the four hyphenated words appear joined as `tshirt`, `yoyo`, `dropdown` and
    `felttip`.
  - The notice calls it "The EFF Large Wordlist". For CC BY attribution of an adaptation, say "as packaged by zxcvbn-ts
    (hyphens removed)".
  - The entropy is unaffected: 7,776 distinct entries, checked at runtime.
- **Infinite loops on a broken source:** `for (;;)` in `suggestPassword` and `suggestPassphrase` (and in `uniformIndex`)
  loops forever if `getRandomValues` returns a constant. For example, all zeros fails the floor forever and hangs the
  page. Bound the retries (for example 1,000) and throw, so a broken source fails closed and visibly.
- **Notes:**
  - §1 says "reports null strength as soon as its value changes". It is actually after paint (m1).
  - §2 says "always agree". That is not true in m2.
- **Catalog headroom:** 138 B remain, which is about 1% (confirmed). This is still an owner decision.

## Probes (`pwux-review/probes/`)

| File                             | Kind                          | Result on the patch                                     |
| -------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `password-setup.probe.test.ts`   | vitest, drop into test/unit/  | 13 pass, 1 **FAILS-NOW** (M1); kills both m6 mutants    |
| `password-setup-probes.spec.ts`  | Playwright, drop into test/e2e/ | not run (port 8787); typechecks; all encode the fixes |
| `disk-probe.mjs` (+ `.out`, `-JK.out`, `-fixed.out`) | standalone, prod dist/ | B1 table (A–I, J–K, and A/E/G/H with the fix) |
| `ui-probe.mjs` (+ `.out`)        | standalone, prod dist/        | m1, m2, m3, m4 measurements                             |
| `lock-probe.mjs` (+ `.out`)      | standalone, prod dist/        | M1(3)                                                   |

The standalone scripts are run as `node probes/<name>.mjs <extension dir>`, with `TMPDIR` pointed at a scratch folder.
`disk-probe.mjs` takes an optional third argument, a comma list of variant letters.
