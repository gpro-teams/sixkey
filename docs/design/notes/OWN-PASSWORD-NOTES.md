# Own password notes: the master password is the user's own

Owner decision of 2026-10-22 (OWNER-DECISIONS/15). A random master password that people look up and copy every time
was unusable and, in practice, less safe. The three layers now are:

- the recovery key, random, for recovery only (its Shamir shares come later, in a separate patch);
- the user's own password, typed once after a browser restart;
- the PIN for every day.

> 2026-10-30 (OWNER-DECISIONS/20, its second note; PIN-RESTART-NOTES.md §18): the PIN now also works after a browser
> restart, so the own password is typed only after 5 wrong PINs in a row, a key change or "End quick unlock now". The
> lock screen's line (lockPinWaiting) now says "The PIN works again once you type the master password."; the older
> wording quoted below ("After a browser restart, an extension reload, 12 hours or 5 wrong tries, …") is history.

This replaces the 2026-10-19 design, in which 50 estimated bits were a hard floor and "Generate for me" was the main
path (PASSWORD-SETUP-NOTES.md, which still describes the generators, the registry, what the browser keeps and the
tolerant prompts). Revision 2 follows an independent review (its report is kept outside the repository; findings are
cited by their numbers, F1 to F9) and the owner's answer to its F1, now in item 1 of the decision. This patch does items
1 to 4 of the decision:

1. the setting flow;
2. a higher PBKDF2 cost for new wraps;
3. the lock screen's line;
4. the docs.

## 1. Setting the master password

### 1.1 Where, and in what order

Every page that sets a master password draws `PasswordFields` (src/options/shared.tsx) with `anyway`:

- first run, a restore into an empty or unreadable profile, and starting over (FirstRun.tsx, one form for all three);
- turning the master password on for a device-key vault (Security.tsx, `EnableBox`);
- changing it (Security.tsx, `ChangeForm`; key-ops.ts `change`);
- the reset with the recovery key (Reset.tsx).

For these, the fields come first. "Generate for me" follows the fields as a secondary button (`btn sm ghost`), and its
box (the value, why, where to keep it, Copy, the other style) appears under it, with "Choose my own" inside it. A
generated password behaves exactly as before: its known entropy, the registry, Copy, and the loose retyping.

A backup file's password (`purpose="file"`) keeps "Generate for me" first and primary, with "Choose my own" beside it.
The sync key operations' fields, behind the release gate, set the master password, so they have its layout (no
`purpose`), but they keep their bar (§1.4).

### 1.2 The rule

One expression decides, on the button and again just before the write:

```ts
masterAccepts(s, anyway) = s !== null && s.floorOk && s.bits >= MIN_GUESS_BITS && (s.ok || anyway)  // strength.ts
```

- `s` is measure()'s answer, so `s.ok` still means "past the floor and at least MIN_BITS".
- `MIN_GUESS_BITS` is log2(10⁶), about 19.9 bits: the meaning of the owner's "not a common password", filled in by the assistant per the spec (OWNER-DECISIONS/15
  item 1, the answer to the review's F1). The service's list has 10 entries, so `Password1234`, `Iloveyou2024` and
  `Football1234` passed it at about 14 bits, a few seconds on one graphics card at 2M. Below 10⁶ guesses the page now
  refuses a master password outright, with no "Use anyway". `Letmein2024!` (23.3 bits) and a memorable password of
  about 34 bits still pass with the warning.
- `anyway` is `anyway === pw`: the page holds the value that "Use anyway" was pressed for.
- `Strength.ok` and MIN_BITS keep their meaning, so the meter lights all ten bars only at 50 bits or more, and never
  for "Use anyway".

The service's floor is `checkPasswordPolicy`, unchanged: 12 characters, not on its list, not repetitive, not a
sequence. It is checked again in the service at each place a master password is set (`requirePolicy`: prepareKeys,
enableMasterPassword, changePassword, prepareReset). The guess floor is the page's only: VaultService is also built by
the service worker, which cannot load zxcvbn's lazy chunks (a service worker has no dynamic `import()`), and putting
zxcvbn in the worker's bundle would add its dictionaries to every start of the worker. A script that called the service directly could
still set a password under 10⁶ guesses that passes the list; the settings page is the only caller. A memorable password of about 34 bits (13 characters) is now
accepted after the warning. The tests use `JennyLovesTea`, 13 characters at 34.2 bits.

### 1.3 The warning and "Use anyway"

Past the floor and 10⁶ guesses, below 50 bits (`meterView(value, s, true).warn`), the field shows three things:

- the line "Estimated 34 bits, below the 50 we recommend.";
- a box: "Someone who copies this browser profile can guess offline, with no limit on tries: one graphics card finds a
  password this strong in about 40 days, and more cards are faster.";
- "Use anyway", a toggle in the page (`aria-pressed`). It is not `confirm()`.

How the time is worked out:

- It is `2^bits × iterations ÷ 1.1×10¹⁰` seconds. The rate is one RTX 5090 running hashcat mode 10900:
  11,157.2 kH/s at 999 iterations (RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md §1.2).
- `iterations` is the count a new wrap gets (§2).
- zxcvbn's bits are log2 of its guess count, the number of guesses a smart attacker needs, so the time is not halved.
- `roughTime` rounds it to whole seconds, minutes, hours, days, months or years (two significant figures above 99), and
  `Intl.NumberFormat` writes it in the page's language ("40 days", "40天"). No unit words are in the catalog. Seconds
  came in revision 2 (F2): before, anything under 90 s read "about 1 minute", 20 times too long for `Password1234`.
  With the guess floor no accepted password is under about 3 minutes, but the figure is right either way.

| Estimated bits | One RTX 5090 at 2M | At 600k (before) |
| -------------- | ------------------ | ---------------- |
| 20             | 3 minutes          | 1 minute         |
| 25             | 1.7 hours          | 31 minutes       |
| 30             | 2.3 days           | 16 hours         |
| 34             | 36 days            | 11 days          |
| 38             | 19 months          | 6 months         |
| 40             | 6.3 years          | 23 months        |
| 45             | 200 years          | 61 years         |
| 50             | 6,500 years        | 1,900 years      |

How the press is held:

- The press counts only for the value it was pressed for. The page holds that value. PasswordFields lets it go
  (`set(null)`) in the same task as any edit (the layout effect that already reports `null` strength), on a lock from any
  page, on `pagehide` and on unmount.
- Typing the same value back needs a new press.
- Pressing it again takes it back.

When the password is refused, the line says why: "Too short: at least 12 characters.", "Too predictable: ..." (the
service's floor) or "Too easy to guess: too close to a common password." (under 10⁶ guesses). No warning and no "Use
anyway" are shown, and nothing passes. An empty field shows "At least 12 characters. 50 bits or
more is best: a few random words work well.". "Use a generated password instead" is still offered under every refusal
and warning.

Existing users change their generated password to their own in Settings › Security › Change password, through the same
form. The current password's field is `MasterField`, so a generated one is still taken loosely. The new password is
wrapped at 2M (§2).

### 1.4 Inventory: who uses MIN_BITS and the policy

| Caller                                                          | Before                    | Now                                                     |
| --------------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| FirstRun.tsx (create, restore, start over): button and re-check | `strength.ok`, `.ok`      | `masterAccepts(…, anyway === pw)`, with the guess floor |
| Security.tsx EnableBox, ChangeForm: buttons                     | `strength.ok`             | `masterAccepts(…, anyway === pw)`                       |
| key-ops.ts enable, change: re-check before the write            | `measure(pw).ok`          | `masterAccepts(measure(pw), anyway)`                    |
| Reset.tsx: button and re-check                                  | `.ok`                     | `masterAccepts(…, anyway === pw)`                       |
| Backup.tsx, both files: buttons and re-checks                   | `.ok` (50 bits)           | unchanged                                               |
| sync/ManageViews.tsx (change, reset through sync)               | `.ok` (50 bits)           | unchanged (§6 item 1)                                   |
| strength.ts `suggestPassphrase` (5 words reach MIN_BITS)        | MIN_BITS                  | unchanged                                               |
| strength.ts `meterView`                                         | the bar                   | the bar, or (`own`) the warning                         |
| pwWhyChars, pwWhyWords ($3 = MIN_BITS)                          | "the $3 bits needed"      | "the $3-bit bar"                                        |
| `checkPasswordPolicy`: service requirePolicy (4 entries)        | the floor                 | unchanged                                               |
| `checkPasswordPolicy`: createBackup, sync keys.ts (2), measure  | the floor                 | unchanged                                               |

## 2. PBKDF2 for new master-password wraps

### 2.1 Measured

- **Set-up:** Google Chrome 156.0.8078.47, headless, driven by Playwright (channel `chrome`), under `nice -n 19`, on the
  development Mac (Apple M3 Max).
- **What:** `crypto.subtle.deriveBits` PBKDF2-SHA256, 256 bits, on a page served from 127.0.0.1 (a secure context),
  after one warm-up derivation.
- **Runs:** two runs of 7 rounds per count, the order reversed every other round.
- **Load:** the machine runs the owner's VMs. The load average was 59.4 / 63.1 / 41.0 throughout the first run and
  11.8 / 11.8 / 12.3 throughout the second; the medians barely moved.

The tool is `extension/scripts/bench/kdf-chrome.mjs` (`nice -n 19 node scripts/bench/kdf-chrome.mjs 7 chrome`).
`scripts/bench-kdf.mjs` is the Node equivalent.

| Iterations | Median, run 1 (ms) | Median, run 2 (ms) | Min–max, both (ms) | Inferred low-end (s)¹ | Guesses/s, one RTX 5090 | Bits over 600k |
| ---------- | ------------------ | ------------------ | ------------------ | --------------------- | ----------------------- | -------------- |
| 600,000    | 47                 | 47                 | 46–48              | 0.4–1.0               | 18,300                  | 0              |
| 1,000,000  | 78                 | 78                 | 77–79              | 0.7–1.7               | 11,000                  | 0.74           |
| 1,500,000  | 117                | 116                | 115–120            | 1.0–2.5               | 7,300                   | 1.32           |
| 2,000,000  | 157                | 155                | 155–162            | 1.3–3.3               | 5,500                   | 1.74           |
| 3,000,000  | 235                | 234                | 232–406            | 2.0–5.0               | 3,700                   | 2.32           |

¹ The repository's estimate for a low-end machine is 0.4 to 1 s at 600k (PLAN §5.1, QUICK-UNLOCK §1.7). That is a
transcribed estimate, not a measurement, and 8.5 to 21 times this Mac. The column scales it linearly.

### 2.2 The choice: 2,000,000

`PBKDF2_PASSWORD_WRAP_ITERATIONS = 2_000_000` (kdf.ts).

- **About 1 s.** On this Mac a password unlock takes 157 ms. On the low-end machine of the estimate, 1.3 to 3.3 s,
  once per browser restart.
- **The worst cases.** These are counts of derivations at 2M:
  - A generated-shape attempt that fails costs two (password-candidates.ts, PASSWORD-SETUP-NOTES §7.3): 0.31 s here,
    2.7 to 6.7 s low-end. Not only generated passwords have that shape: five words of 3 to 9 letters do too, which is
    what the hint under an empty field recommends, so every wrong unlock of such a password costs two (review F9).
  - A password change from a loosely typed generated password costs at most three (two to open, one to wrap): 0.47 s
    here when the old wrap is 2M, and up to about 10 s low-end. An existing user's 600k wrap makes it two at 600k and
    one at 2M, about 0.25 s here.
- **Why not more.** 3M would add 0.58 bits for 50% more time on the slowest machines. The repository's study calls "up
  to about 2M" defensible for local-only vaults, calibrated per machine at setup, and not where security comes from
  (RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md §1.4); 2M here is a fixed count, for the reasons in §6 item 4. Iterations
  do not make a weak password strong (each doubling buys 1 bit); the guess floor, the warning and the account key (§6
  item 2) do the rest.
- **What it buys.** An attacker's cost per guess is 3.33 times that at 600k: +1.74 bits for every password, generated
  ones included.

### 2.3 Where it applies

- **Only `VaultService`'s own wraps.** Its `ctx` passes `iterations: this.iterations ?? PBKDF2_PASSWORD_WRAP_ITERATIONS`
  to every key operation that makes a password wrap: prepareKeys (first run, restore, start over),
  enableMasterPassword (`rekey`), changePassword, prepareReset, and rotateKey (`rekey`, a new VK so a new wrap). The
  recovery wrap is HKDF and does not look at it.
- **Unchanged.** `PBKDF2_DEFAULT_ITERATIONS` stays 600,000, and so does everything that names no count: the PIN's
  set-up (pin.ts `newPinKdf`; pin-admin.ts reads the service's raw test hook, not `ctx`), backup files (`createBackup`)
  and the whole sync engine.
- **Sync is decoupled by construction.** keys.ts calls `setPassword` and `rekey` with `{ now, rng }` only, and
  `newBundleAuth` calls `newPbkdf2Params(rng)`. So the sync engine's change of password, its reset, its rotation and
  `pw_auth` keep 600k, and no sync file changed. A test pins it, with mutants for both directions.
- **One interaction with sync.** Turning sync on uploads the local keyring, whose password wrap is now 2M. That is
  inside the contract's bounds (api/openapi.yaml: 600,000 to 20,000,000) and `assertKdfParams`. A joining device then
  derives at 2M. A later change made through sync goes back to 600k (§6 item 3).

### 2.4 Old wraps

- A wrap is read at the count it carries. `assertKdfParams` keeps its range, 600,000 to 20,000,000, so a 600k wrap
  still opens everywhere, and a tampered file still cannot go below 600k.
- Nothing re-wraps on an unlock. The test unlocks a 600k vault at the lock screen, verifies it from the settings page
  and opens it with the PIN, then checks that the keyring is byte for byte the same and that no slot or keyring key was
  written. The next password change, reset or rotation makes the new wrap at 2M.
- **Vectors and fixtures that pin 600k** are unchanged, and all still pass:
  - the format fixture test/fixtures/crypto-v1.json, which crypto-compat opens;
  - the PBKDF2 known answer in crypto-primitives (a primitive at an explicit count);
  - the PIN's (quick-pin-crypto);
  - sync's (m2-sync-local, sync-crypto-adversary, the contract vectors in contract/tools/gen-vectors.mjs).
- **Cost in tests.** At the production count the unit suite took twice as long (1,458 to 1,776 s against about 772 s),
  which would not fit CI's 30-minute job (review F3). The worlds that test the order of writes, crashes and sync, not
  the count, therefore pass the service's test hook at 600k (`TEST_KDF_ITERATIONS`, test/helpers/kdf.ts):
  - test/helpers/m3-world.ts (`contextOver`; `kdf: "production"` or `World.productionKdf` leaves the shipped count);
  - test/helpers/m2-crash.ts, test/helpers/m2-world.ts, test/helpers/quick-world.ts;
  - test/fault/gm2-crash-matrix, security-log-crash and keychange-marker.

  What still runs at 2M:
  - own-password.test.ts: every key operation, the 600k-to-2M change, and a sync world at the production count;
  - password-entry-service.test.ts's own runtimes (`createRuntime`; its sync world is at 600k);
  - the files that build the service as shipped and use none of the worlds above: test/unit service, platform,
    read-budget, quick-read-budget, export-gate, import-backup, backup-subset, backup-subset-fuzz, sidepanel-guard,
    m5-sw-locks and m5-source-rules; test/fault open-view-diff; test/regression a2-review, clock, create-crash,
    enable-crash, gm2-fixes, merge, purge, session, store-misc and write-read-mismatch;
  - every e2e spec, against real builds.

  A source rule checks that no shipped code passes the hook.

### 2.5 How long the vault lock is held

A rotation and a password change derive inside the vault's lock (`store.transact`): up to two derivations at the
stored count to open (a loosely typed generated shape) and one at 2M for the new wrap; turning the password on, one at
2M. That is at most about 0.47 s here, and 4 to 10 s on the low-end estimate, during which every other context's
`loadView` (the popup, the side panel, autofill) waits on `sixkey-vault`. Nothing is at risk: the commit is atomic and
the recovery key is handed over right after it. Deriving before the lock and comparing the base keyring, as
prepareReset does, would shorten the hold (review F8); it is left as it is, since these operations are rare and
explicit.

## 3. The lock screen's line

### 3.1 When

The line shows when all of these hold:

- a PIN is set up for these keys (`sk_pin` parses, and its vaultId and vkId are the keyring's);
- the session quick unlock cannot be used (`lockScreenQuick` returned null: a browser restart, an extension reload,
  12 hours, 5 wrong tries, a hard lock, a key change);
- the profile is not declared shared.

These are `arm()`'s conditions, so the line is true: typing the master password arms the PIN again.

### 3.2 What it says

"After a browser restart, an extension reload, 12 hours or 5 wrong tries, the PIN needs the master password once."

It appears in three places, always under the master password's field:

- the popup's lock screen (`#pin-waiting`);
- the side panel's, which is the same screen;
- the settings page's unlock bar (`#unlock-pin-waiting`).

### 3.3 How

- `openView`'s locked branch works out a boolean. The view carries `pinAfterPassword: true` or nothing, the screen
  passes it on, and nothing else leaves.
- `sk_pin` already came with the pointer's get (`also`). The profile needs the settings, which the session router reads
  but does not hand out. So `openView` adds `sk_settings` to the same get.
- That is **one more key inside an existing read**. The lock screen still makes 3 local gets and reads exactly
  `sk_session`, `sk_quick` and `sk_pw_format` from the session area. quick-read-budget, read-budget and
  password-entry-service pass unchanged, and own-password.test.ts checks the lists.
- A separate `settings.get()` would have been a fourth local get. Passing the router's settings out would have changed
  the quick unlock's routing code. No `ServiceCore` member was added, because budget-split pins them.
- The settings page's unlock bar uses `PinAdmin.state()`, which it already reads there: available, set up, not armed.
  It reads it again when a PIN unlock there says the PIN cannot be used (the 5th wrong try, or expired), so the line
  comes without a reload (review F7). The reads are numbered, so an older one that answers late is dropped and never
  puts back a PIN that has ended. The popup's screen shows it at once after a 5th wrong try made on it; when the
  PIN merely expired while the screen was open, the line comes at the next opening.

### 3.4 What it tells, and to whom

It tells someone at the lock screen that this profile has a PIN. The PIN screen itself says as much whenever the PIN
works. It is never shown in a profile declared shared, by the `profile` marker or by the older three settings, where the
PIN is never armed.

## 4. Text and size

There are seven new keys, in scripts/i18n/ownpw.py:

- `strengthHintOwn`, `strengthLowOwn`, `strengthShort`, `strengthCommon`, `pwWeakWhy`, `pwUseAnyway`, in core;
- `lockPinWaiting`, in the unlock part and the popup's catalog.

Three existing keys are reworded: `pwWhyChars` and `pwWhyWords` ("bar", not "needed"), and `deviceOnlyBody`, the
Phase 0 box's text, which said a master password "fixes" access to the profile and now says a copy of the profile is
as safe as the password chosen (review F5).

Measured on prod builds of the tree with autofill Stage 2 patch 3, before and after:

| Gzipped bytes                     | Before | After  | Limit  |
| --------------------------------- | ------ | ------ | ------ |
| Popup, store build (gate closed)  | 55,773 | 55,957 | 61,440 |
| Popup, release gate open          | 56,980 | 57,168 | 61,440 |
| Side panel (gate closed)          | 57,983 | 58,171 | 63,488 |
| Settings core zh_CN               | 3,546  | 3,740  | 5,120  |
| Settings security zh_CN           | 3,306  | 3,327  | 5,120  |
| Settings unlock zh_CN             | 683    | 774    | 3,072  |
| Settings text with a vault, zh_CN | 11,201 | 11,440 | 12,288 |
| Settings text, every part, zh_CN  | 11,721 | 11,962 | 12,288 |

- With the gate open, the popup has 4,272 B of headroom; the owner's floor is 1,500 B.
- The tightest is the settings page's every-part stream, with 326 B left (§6 item 6).

## 5. Tests

- **test/unit/own-password.test.ts** (23 tests):
  - `masterAccepts`, as a table and as a property, the guess floor at its edge;
  - the review's common passwords refused outright, and those above 10⁶ guesses warned;
  - the owner's case;
  - the floor blocking with "Use anyway" too, in the view and in the service at all four entries;
  - meterView's own mode, as a property;
  - generated passwords unchanged;
  - the time figure and `roughTime`, seconds included;
  - backup and sync keeping the bar;
  - the counts;
  - new wraps at 2M from every operation;
  - a 600k vault opening at every prompt, written nothing by an unlock, re-wrapped at 2M by a change;
  - the PIN and backup files at 600k;
  - the sync engine decoupled, by its calls and through a real sync world at the production count: the first upload
    publishes the 2M wrap with `pw_auth` at 600k, a join opens it, a change through sync wraps at 600k;
  - no shipped code passing the test hook;
  - every call that sets a master password (prepareKeys, enableMasterPassword, changePassword, prepareReset) found by
    a scan of src/, with its `masterAccepts` re-check right before it, and no other caller;
  - the line: a live PIN, the end of quick unlock, a browser restart, 5 wrong tries, 12 hours, no PIN, a PIN of another
    key or vault, a damaged one, a shared profile (both markers), only a boolean, the read lists, no write.
- **test/unit/own-password-dom.test.ts** (13 tests): rendered by Preact into test/helpers/mini-dom.ts.
  - the order by purpose;
  - the warning's text and its time;
  - the toggle, let go by an edit, by retyping, by `pagehide`, and when the fields unmount under a page that stays;
  - the three refusals ("too easy to guess", "too short", "too predictable");
  - a generated password;
  - no warning without `anyway`;
  - the real change form handing the press to key-ops;
  - the popup's line, from the view and after a 5th wrong try on the screen, and never after an "ended" answer (which a
    profile declared shared gives).
- **test/unit/own-password-pages-dom.test.ts** (7 tests, review F6): PasswordFields replaced by a stub, so that each
  page can be handed a press for another value, which the real component never leaves behind.
  - FirstRun, the reset, turning the password on and changing it: the button stays disabled, and the page's own last
    check refuses (or hands key-ops `false`); pressed for this value, the write goes ahead.
  - The unlock bar: no line with a live PIN, also after "Use master password" (the reviewer's R17); the line when set
    up and not armed; none in a shared profile; the line at once after the 5th wrong PIN there; an older read
    answering after a newer one dropped.
- **Changed tests:**
  - password-setup.test.ts: the order's source rule per purpose, the re-checks through `masterAccepts`, `warn` in the
    view;
  - short-settings-state.test.ts: key-ops takes the press, with a new test;
  - quick-pin-service.test.ts and quick-pin-races.test.ts: seven lock screens now carry the flag (after the 5th wrong
    PIN, a restart, an expiry, a key or password change, and a stale look racing a new PIN);
  - the worlds of §2.4 at the test count;
  - the e2e specs password-setup, firstrun and reset: the order, the warning, and (reset) a password now too easy to
    guess.
- **test/e2e/own-password.spec.ts** (3 tests):
  - first run: too short, too easy to guess (`Password1234`), then an own 34-bit password with the warning, the toggle,
    no dialog; 2M on disk; it opens after a browser restart;
  - an existing user's generated password at 600k, opened loosely, still 600k; changed to an own one with "Use anyway";
    2M; the old one refused;
  - the line after the end of quick unlock and after a browser restart, in the popup and the unlock bar; gone once the
    PIN works again; never in a shared profile.
- **Results** are in §5.1.

### 5.1 Results

Revision 2, on the live tree (with autofill Stage 2 patch 3 and its smoke.spec fix):

- **Unit.** The full run (`npx vitest run --maxWorkers=2`, `nice -n 19`): 233 files, 3,402 passed, 4 expected failures
  (the `it.fails` sync probes), 1 skipped, in 883 s at a load average of 18 to 22. Revision 1 took 1,776 s; the tree
  before this change, about 772 s. The slowest files are now the m2 crash matrices (175 s at most).
- **End to end.** Serially, in a scratch copy with the API port moved from 8787 to 18787 everywhere it is spelled (both
  manifests included), against prod, e2e and dev builds: own-password, password-setup, firstrun, reset, quick-pin,
  pw-entry, flows, sidepanel, short-settings, visual-guard, perf (its read gates included), export, export-selection,
  autofill2, errors, security-log, smoke and popup-text. 146 of 146 passed.
- **Mutants.** Hand-made mutants were applied one at a time in a scratch copy, against own-password, own-password-dom,
  own-password-pages-dom, short-settings-state, password-setup, quick-pin-service, quick-pin-races and crypto-compat
  (163 tests, all passing unmutated). The eight marked "behaviour" ran against the three DOM and state files only, with
  no source rule, so that what the page does has to catch them. All 41 were killed:

  | Area                  | Mutant                                                                                               |
  | --------------------- | ---------------------------------------------------------------------------------------------------- |
  | The iteration count   | 2M changed to 600k; 2M changed to 1.5M; the service's `ctx` back to the default count                |
  | Decoupling            | `setPassword`'s default made the new count (sync); the PIN's set-up given the new count              |
  | The old-wrap read     | derive at the new count instead of the stored one; the range check refusing 600k                     |
  | The policy floor      | the service's check removed; 11 characters; `masterAccepts` without `floorOk`                        |
  | The guess floor       | removed; 10⁵ instead of 10⁶; the warning offered under it                                            |
  | The warning gate      | below the bar accepted without the press; the press ignored (the old bar); an edit keeping the press  |
  |                       | the press outliving the unmount; a lock or `pagehide` not emptying the values                        |
  |                       | key-ops' re-check taking any change as pressed; a page passing `anyway !== null`                     |
  |                       | the warning (and "Use anyway") shown for a password the floor refuses                                |
  | The page's binding    | behaviour: FirstRun's button and its re-check, the reset's button and its re-check, EnableBox's      |
  |                       | button and its call, ChangeForm's call, each passing any press                                       |
  | The warning's time    | no seconds                                                                                           |
  | The line's condition  | shown with a live PIN; a PIN of another key; a PIN of another vault                                  |
  | Shared suppression    | removed; the settings not read with the pointer                                                      |
  | Reads                 | the settings read with a get of their own                                                            |
  | The pages             | the unlock bar's line in a shared profile; the popup's line never drawn; the generator first again   |
  |                       | behaviour: the unlock bar without `armed === null` (R17); no second look after its 5th wrong PIN;    |
  |                       | the popup without the line after a 5th wrong PIN on its screen                                       |

  In revision 1, one mutant was equivalent: removing the press's release from the lock handler, which empties the
  value, and the value's change lets go of the press anyway. That line was removed; the unmount's release, which nothing
  else covers, has its own test and mutant.

## 6. Decided here, and open

1. **The sync key operations keep the 50-bit bar,** but that bar is not what protects a synced password (review F4).
   Turning sync on uploads the password as it is, and the server's cheapest oracle is `password_verifier`, PBKDF2 at
   the `auth.kdf` count (600k) whatever the wrap's count. So before `SYNC_UI_IN_STORE_BUILD` flips, turning sync on must
   either check the password's strength or require the device-held account key: a launch item in SYNC-DESIGN §9 item 17.
   When that lands, the owner decides whether sync's fields follow the master password's rule.
2. **The account key is not built here.** The decision says it does not block this change. local-vault.md's known gaps
   say so.
3. **The sync engine's own wraps stay at 600k**, as the task asked ("do not change anything in the sync engine"). With
   sync on, a password changed through sync is wrapped at 600k, and one changed locally is refused (sync_on). When
   sync's key operations are next worked on, `PBKDF2_PASSWORD_WRAP_ITERATIONS` is the obvious count for them.
4. **2M is a fixed count**, not calibrated per machine. Calibration would make a sync account's wrap cost depend on the
   fastest device that made it, which a slow device then pays. 3M is the next step if the owner prefers.
5. **Backup files keep "Generate for me" first and the 50-bit bar.** The decision is about the master password, and a
   backup file travels.
6. **Catalog headroom.** The settings page's every-part stream has 326 B left in zh_CN. BUDGET-NOTES §5 has the
   options.
7. **The line tells someone at the lock screen that a PIN is set** (§3.4). The owner checklist (item 28) asks the owner
   to confirm this is acceptable.
8. **"Use anyway" holds for the value only**, with nothing remembered: each new password asks again.
9. **Research reports are dated snapshots.** docs/research/security-incidents-report.md and ux-study.md cite the 50-bit
   floor and 600k as the defences of their time. They were left as written.
10. **What "not a common password" means: decided** (the assistant per the owner's spec, OWNER-DECISIONS/15 item 1; the owner may change it): under 10⁶ zxcvbn guesses,
    refused outright, on the pages only (§1.2).
