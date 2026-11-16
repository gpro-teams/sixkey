# BUDGET.patch: review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: the word "independent" removed from
> the heading and an absolute local path shortened. Paths under `scratchpad/` were the reviewer's temporary working
> copies (probes, mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes
> it or as it was adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to
> read these records: [`docs/audit/README.md`](../README.md).

## Setup

- **Patch.** `scratchpad/BUDGET.patch`.
  - SHA-1 `0d8743809c277baaccad2221b56958f1bb84e5de`, which matches the "0d874380" given.
  - SHA-256 `ae6229f7…`, in case someone checks that hash instead.
- **Copies.**
  - The patch was applied with `patch -p1 -E` to a private copy of the live tree, `budget-review/new`.
  - An unpatched copy is in `budget-review/orig`.
  - Mutants run in `budget-review/mut`, a third copy with a scratch-only `git init`, so each mutant is reverted with
    `git checkout`.
  - The live tree was not edited, and nothing was committed in it.
- **node_modules.** Both copies use APFS clones of the live tree's node_modules. That tree has a self-symlink,
  `node_modules/node_modules -> <live repository>/extension/node_modules`. The first build's stack trace showed
  rolldown resolving from the live tree through it, so I removed the symlink from my copies only. The live tree still has
  it; someone may want to delete it there.
- **Paths.** Below, paths are relative to `extension/` in the patched copy unless they say otherwise. My scripts are in
  `budget-review/tools/`: `pure-move.mjs`, `catcheck.py`, `popupgz.mjs` and `mut.py`. Mutant output is in
  `budget-review/mutants.log`.

## Findings

### BLOCKER

None.

- **The service split is a pure move.** I checked it with my own TypeScript-AST comparison, which shares no code with
  the implementer's script.
- **Crypto, storage and sync semantics are unchanged.** No await order, lock, session-lifetime check, error mapping or
  security-record write is different. Details are under A below.

### MAJOR

**M-1. Nothing caps the settings page's total text any more, and `FULL_CATALOG_GZ` no longer limits anything real.**
Locations: `scripts/check-dist.mjs:37` and `:482-489`; `scripts/messages.py` `BUDGETS`.

- **What the code does.**
  - Before the patch, all of the settings page's text was one chunk, held in prod to 12,288 B gzipped.
  - After the patch, `FULL_CATALOG_GZ` is used once, at `:486`: `if (budget > FULL_CATALOG_GZ)`. That compares each
    per-part budget constant with 12 KB.
  - No measured size is compared with it, and nothing adds the parts up.
- **Failure scenario.**
  - The page draws core and the five sections for every vault, and adds `unlock` while locked (`partsFor`,
    `src/options/parts.tsx:74-77`).
  - Under the per-part budgets, the text on that first paint can grow to 22,528 B unlocked (5,120 + 5,120 + 4 × 3,072),
    or 25,600 B locked, with no check failing.
  - That is roughly double the old ceiling.
- **Against the notes.**
  - BUDGET-NOTES opens with "No limit was raised". In effect, the 12 KB ceiling on the settings page's text became about
    22 to 25 KB.
  - §5 does say "the total is no longer capped" and calls the budgets the owner's to confirm.
  - But the headline reads as if the old limit still held. Keeping `FULL_CATALOG_GZ` as a mere ceiling on the budget
    constants keeps up that appearance.
- **Measured today, zh_CN, built chunks.**

  | What                                          | Sum of each chunk's gzip | gzip of the chunks concatenated |
  | --------------------------------------------- | ------------------------ | ------------------------------- |
  | Unlocked first paint (core and five sections) | 11,805 B                 | 9,464 B                         |
  | Locked first paint (the same, plus unlock)    | 12,488 B                 | 9,817 B                         |
  | Empty profile (core and firstrun)             | 4,415 B                  | 4,106 B                         |
  | Old single catalog                            | 12,233 B                 | (one chunk)                     |

  The old figure includes the 96 popup and Chrome keys, which no settings part carries. The 9,817 B does not mean the
  split shrank the text.

  - The locked view's sum of chunks is already above the old 12,288 B line.
  - The concatenated measure is one gzip stream, like the old metric, and it has about 2.4 KB of headroom.
- **The Sync section's cap doubled the same way.**
  - Each of its two catalogs keeps `SYNC_CATALOG_GZ` = 12 KB, and `text.ts` loads both before the section draws. So the
    section's text ceiling went from 12,288 B to 24,576 B.
  - Measured on dist-e2e, zh_CN: `sync` 8,544 B plus `sync-manage` 4,322 B, which is 12,866 B summed and 11,885 B
    concatenated. Before, it was 11,888 B in one chunk.
  - So under the old metric the section has gained no room (403 B left). All of its relief comes from the second
    12 KB allowance.
  - This was M6-NOTES' planned alternative, so it may well be intended. It should still be stated as a raised limit,
    not as "no limit was raised".
- **Fix (adoptable).** Add an aggregate rule to check-dist:
  - Enforce it in prod and e2e.
  - For each view's set of parts (`partsFor` of `empty`, `unlocked` and `locked`, plus core), gzip the concatenation of
    that set's chunks, per language.
  - Fail above `FULL_CATALOG_GZ`, for example:
    `settings page (locked, zh_CN): 9817 B gz of text on first paint, over 12288`.
  - This passes today (9,817 B at most) and keeps the old limit's meaning.
  - Add an assertion to budget-split that the view sets equal `["core", ...partsFor(state)]`.
  - For the Sync section, either hold `sync` and `sync-manage` concatenated to one stated total, or record 24 KB as the
    decision.

  Otherwise, record the new totals (settings page about 22 to 25 KB, Sync section 24 KB) as an owner decision in
  `OWNER-DECISIONS/`, and change "No limit was raised".

### MINOR

**m-1. A protected member can be reached from any new subclass, and no rule stops that.**
Mutant K9 survived both the unit tests and `npm run typecheck`. Locations: `core/service/service-core.ts:221-234`;
`test/unit/m2-source-rules.test.ts:103-110`.

- **The existing rule.** The tree already decides which modules may reach the service's internals. m2-source-rules
  lets only `sync-flows.ts` and `pin-admin.ts` use element access (`s["session"]`, `s["record"]`, ...).
- **What the patch adds.** It makes 18 members protected, among them `session` (the session cache, which hands out the
  raw vault key), `store`, `rng`, `currentVk`/`requireVk` (which return the raw `Vk`), `startSession` and `record`.
  That opens a second door the rule does not see.
- **The mutant.** `src/options/shared.tsx` gains `class Peek extends ServiceCore { peek() { return this.session } }`.
  Every test and the type check pass.
- **Runtime impact.** None: TypeScript privacy was never enforced at runtime. But it weakens a compile-time boundary the
  project chose to pin with a test.
- **Fix (adoptable; tested).** In `mut/`'s budget-split, it passes on the clean tree and fails with K9 applied
  (`+ "options/shared.tsx"`). Add it to budget-split's "the service in two classes":

  ```ts
  it("ServiceCore is extended by VaultService only, and VaultService by nothing", () => {
    const at = (re: RegExp) => files.filter((f) => re.test(code(f.text))).map((f) => f.path);
    expect(at(/\bextends\s+ServiceCore\b/)).toEqual(["core/service/service.ts"]);
    expect(at(/\bextends\s+VaultService\b/)).toEqual([]);
    expect(at(/import\s*\{[^}]*\bServiceCore\b[^}]*\}\s*from/).sort()).toEqual([
      "core/service/service.ts",
      "platform/runtime-base.ts",
    ]);
  });
  ```

**m-2. A lock now waits for a chunk import before the settings page drops the vault.**
Location: `src/options/App.tsx:78-94`.

- **The sequence.**
  - A page opened unlocked has loaded the five section parts only.
  - On a lock from anywhere, the lock-epoch listener calls `reload()`, and `status()` returns `locked`.
  - Then `await loadParts(partsFor("locked"))` must first fetch the `unlock` chunk.
  - Only after that do `setStatus` and `setVault(null)` run.
- **Before the patch,** `setStatus(locked)` ran straight after `status()`, and the vault went after one more storage
  read.
- **The cost.** Normally a few milliseconds. But QUICK-UNLOCK §5.12 item 3 says the page "drops its vault at once".
  Every load is chained through `applied`, so an import that never settles would leave the decrypted vault on screen
  until the page closes.
- **Fix, either of:**
  - Put `unlock` in `partsFor` for every vault state. That is 683 B zh_CN at first paint, and a lock never waits.
  - In `reload()`, call `setVault(null)` before awaiting the parts whenever `st.state !== "unlocked"`.

**m-3. The loader's ordering and failure paths have no tests.**
Mutants K11, K11b and K12 survived. Location: `src/options/parts.tsx:88-113`.

- **What is tested.** The only runtime test, budget-split "loadParts", covers the happy path and dedupe. The wrapper's
  gating is checked with a regex on its source.
- **The three mutants that live:**
  - K11: `ready.add` before the text is merged.
  - K11b: `ready.add` as soon as a part is requested, before the fetch.
  - K12: no English fallback.
- **Why K11b matters.** Under it, any re-render of a lazy part's wrapper during the fetch draws key names. For example:
  - the wizard opened from Backup;
  - App re-rendering for `setHolding`.

  The e2e guard catches that only if a render happens to fall in the window.
- **Fix.** Give `loadParts` an injectable source, or `vi.mock` the JSON modules. Then assert three things:
  - a rejecting zh_CN part yields English text;
  - a part that rejects in both languages leaves `t()` showing key names, without an unhandled rejection;
  - `ready` (exported for the test) is never true before `t()` returns the part's text. Check it from a source that
    resolves later.

**m-4. The section parts start loading only after `status()`, one step after the other.**
Locations: `src/options/main.tsx:16`; `App.tsx:80-81`.

- The page now reads six local chunks, or seven when locked, instead of one.
- Only core starts before the first render. The five sections start after `status()` resolves, so their load time adds
  to it instead of overlapping it.
- These are extension files, not network requests. I did not measure the delay in a browser.
- **Fix.** Start the section loads in `reload()` alongside `status()`, for example
  `const [st] = await Promise.all([rt.service.status(), loadParts(SECTIONS)])`, then await `partsFor(st.state)` as now.
  - Every non-empty state needs the sections, and `textOf` dedupes.
  - An empty profile then fetches five parts for nothing.
  - Either this or a prefetch in main.tsx means changing budget-split's pinned load-order assertions: "the page draws
    nothing before its core text … no part is loaded up front", the App regex, and the `loadParts(` counts. The
    implementer's mutant L1-3 relies on those. Change them in the same patch, deliberately.

**m-5. `docs/ARCHITECTURE.md:40` and `:57` are now untrue.**

- They say each context builds its own `VaultService` in `src/platform/runtime.ts`. The popup now builds `ServiceCore`
  through `src/platform/runtime-base.ts`.
- CONTRIBUTING rule 9 ("Documents say what the code does") asks the same change to correct them.

### NIT

- **Sync catalogs load one after the other.** `src/options/sync/text.ts:19-27` awaits the Sync section's two catalogs
  in sequence. `Promise.all` would fetch both chunks at once.
- **messages.py writes before it checks.** `scripts/messages.py:270-292` writes every catalog, then checks the budgets.
  - On a refusal, the over-budget files stay on disk and the exit code is 1.
  - This is harmless, because check-dist measures the built chunks on its own (mutant K4).
  - The message could say the files were written.
- **The CI freshness check ignores untracked files.** `.github/workflows/ci.yml:53` runs
  `git diff --exit-code -- _locales catalogs`.
  - A newly generated catalog that was never committed passes that step. Today the build fails first, on the unresolved
    import, so this only adds safety.
  - `test -z "$(git status --porcelain -- _locales catalogs)"` would close it.
  - The step predates this patch, but the patch adds 18 generated files.
- **The type-level POPUP_API check only runs in typecheck.** `test/unit/budget-split.test.ts:133-138`,
  `expect(allListed).toBe(true)`, can never fail under vitest, because types are erased. POPUP_API is held by
  `npm run typecheck` only. That is fine, since CI runs it (mutants K10 and K10b were killed by both tsc and the
  protected-list regex), but the comment could say so.
- **Member count.** The notes say "66 members". The class has 80: 66 methods and accessors, 13 fields and the
  constructor. Say which count is meant.
- **`hasDevice` still has a copy.** `core/service/pin-admin.ts:30` keeps its own (this predates the patch). The notes'
  "the same predicate instead of a copy" is true of service.ts only.
- **Mixed-language pages.** Fallback is now per part. If one zh_CN part chunk fails, that part shows English and the
  rest Chinese; before, the whole page fell back together. That is acceptable, but worth a sentence in the notes.
- **The popup catalog lost one key: `changePassword`.** It was only a mention, the name of a VaultService method; it was
  never drawn. This is expected, and it is where the popup catalog's 11 to 15 B went.

## What I verified, and the numbers

### A. The service split

**Pure move** (`tools/pure-move.mjs`, using the TypeScript compiler API):

- The original `VaultService` has 80 members. They split into 39 on `ServiceCore` and 41 on `VaultService`.
- Each member appears exactly once, none is new, and none is missing.
- Every member's code is identical modulo whitespace and the visibility keyword.
- The only text differences are five moved or duplicated `// ----` section-header comments.
- Exactly 18 visibility changes, all private to protected: the 12 fields other than `formats`, which stays private,
  plus `currentVk`, `requireVk`, `startSession`, `saveFormat`, `finishKeyChanges` and `record`.
- No other modifier changed: `async`, `readonly` and `get` are all as before.

**Top-level statements.**

- Each original statement appears exactly once across the two files.
- The one exception is `hasDevice`, which gained `export` and a JSDoc comment; its body is identical.
- The one new statement is the re-export block in service.ts.
- `preparedKeys`, `preparedResets` and `LANDED` exist once, in service.ts.

**Behaviour.**

- Inside each member nothing moved, so the order of awaits, the locking, the session epoch checks, the
  `record`/`diag` calls and the error mapping are textually unchanged.
- Each `this.*` call resolves on the same instance, now through the prototype chain.
- `VaultService` declares no fields and no constructor, so class-field semantics re-initialise nothing.
- The service has no zeroisation calls, before or after.

**Wiring.**

- `runtime-base.ts` `buildRuntime` is the old `createRuntime` body with `new VaultService(...)` replaced by `make(...)`.
  I diffed it: the only other changes are comments and imports.
- `runtime.ts` `createRuntime` builds VaultService over it.

**Construction sites.**

- `new VaultService` appears only in `platform/runtime.ts`, and `new ServiceCore` only in `runtime-base.ts`. The 30
  test files that build VaultService directly are byte-identical to before. Two more files match the string, but only
  inside a regex: m5-source-rules and budget-split.
- `createRuntime` is used by `sw.ts`, `options/App.tsx` and `devsync/main.ts`. `createPopupRuntime` is used by
  `popup/App.tsx` only.
- The offscreen document builds no runtime.
- `SyncFlows` and `PinAdmin` take a `VaultService`. They reach members by element access, which tsc checks under
  strict mode, so a missing member is a type error and not a runtime "not a function".
- No `instanceof VaultService` exists anywhere, and no e2e or test hook exposes the popup's service.

**Popup call surface.**

- Everything the popup calls is a `ServiceCore` method: `openView`, `unlockWithPassword`, `unlockWithRecoveryCode`,
  `unlockWithPin`, `mutate`, `ackEvents`, `lock` and `touch`.
- No call is made by name or through a message handler. The popup's code is typed on `PopupRuntime`, and tsc passes.

**Popup graph.** Mutants K8, K14, K19 and K20 below show the graph rules hold:

- the module-graph tests reject `service.ts` and `runtime.ts`;
- check-dist rejects the settings catalogs from the popup;
- the popup folder's import rule rejects a direct import.

### B. The catalog split

- **Patch applied alone.** Before `python3 scripts/messages.py` is run, the build fails loudly with
  `UNRESOLVED_IMPORT ../../catalogs/settings-*-*.json`. Nothing goes silently green.
- **Running messages.py** (with node: an exact measurement):
  - It writes 16 settings part files plus the 2 sync-manage files.
  - `_locales/{en,zh_CN}` are byte-identical to before.
- **Independent check** (`tools/catcheck.py`), for en and zh_CN, the only locales in the tree:
  - The parts are disjoint, and hold 401 of the 497 keys.
  - Every part's text equals `_locales`.
  - The union of `sync` and `sync-manage` equals the old `sync-<lang>.json` exactly, and the two are disjoint
    (325 and 151 keys).
- **The 96 keys in no part.**
  - None is quoted anywhere in non-popup source (src/options, src/ui, src/core, ...), except `syncBadgeTitle`, which is
    Chrome's: `getMessage` in `platform/sync-worker.ts`.
  - The build plugin's union check also passes: no quoted unplaced key is in any chunk the settings page can load.
- **The collector** handles the dynamic cases correctly:
  - a template family that crosses parts is caught (K5);
  - a key passed into a part as a prop fails closed under rule 6 (K6);
  - a template family that stays within its part passes (control K5a);
  - a key placed in the wrong part is caught by budget-split, though messages.py accepts it, as it should, since it is
    only data (K7).
- **Loader** (`src/options/parts.tsx`):
  - Fetches are cached per part, and overlapping loads dedupe.
  - Merges are serialised through `applied`.
  - It never rejects: on a failure it falls back to English for that part, then to `{}`, which shows key names.
  - Switching language reloads the page (`Rail.tsx:149-150`), so every part is fetched again in the new language. No
    in-page switch path exists.
  - Every part component is reached only through `gated()`.
  - `App.reload()` awaits the view's parts before `setStatus`.
- **Unit suite**, run once in the patched tree with the catalogs regenerated (`--maxWorkers=2`, 723 s): 182 files
  passed; 2,561 tests passed, 4 expected failures, 1 skipped. That is exactly the implementer's figure.

### C. Budgets (my measurements; popup bytes by my own `tools/popupgz.mjs`)

**Popup, gzipped:**

| Popup bundle             | Before (orig) | After (patched) | Budget | Headroom |
| ------------------------ | ------------- | --------------- | ------ | -------- |
| Store build, gate closed | 60,394        | 57,438          | 61,440 | 4,002    |
| Store build, gate open   | 61,287        | 58,301          | 61,440 | 3,139    |

- **Gate closed, after:** static 53,279 B plus the largest catalog, popup zh_CN at 4,159 B.
- **Gate open, after:** static 53,944 B plus popup zh_CN at 4,357 B.
- The popup can reach exactly two catalog chunks, `popup-locale-en` and `popup-locale-zh_CN`, and no settings or sync
  chunk.

**Settings parts** (B gz, en / zh_CN, identical in prod and e2e):

| Part     | en / zh_CN    | Budget |
| -------- | ------------- | ------ |
| core     | 2,992 / 3,462 | 5,120  |
| security | 2,725 / 3,311 | 5,120  |
| accounts | 1,195 / 1,445 | 3,072  |
| backup   | 938 / 1,151   | 3,072  |
| misc     | 903 / 1,093   | 3,072  |
| general  | 1,057 / 1,343 | 3,072  |
| firstrun | 763 / 953     | 3,072  |
| unlock   | 532 / 683     | 3,072  |

**Sync catalogs, gate open:**

- `sync` is 7.5 / 8.3 KB (8,544 B zh_CN).
- `sync-manage` is 3.7 / 4.2 KB (4,322 B zh_CN). Each is under its own 12 KB limit.
- The old single `sync` catalog was 11.6 KB zh_CN.

**Gate closed:** `dist/assets` has no `sync-*` file, and no `locale-*` (full catalog) chunk.

**check-dist passes** on prod (gate closed), prod with the gate open, and e2e. All gate-open measurements, before and
after, came from scratch copies with `SYNC_UI_IN_STORE_BUILD = true`.

**Budgets are enforced, not just reported:**

- Lowering core to 3,400 in check-dist fails it with "core (zh_CN) is 3462 B gz, over its budget of 3400 B" (K1).
- A part's budget set to 13,000 fails both check-dist and budget-split (K2).
- messages.py and check-dist disagreeing fails budget-split (K3).
- Growing core past its budget refuses at messages.py. A build of the files it still wrote is then refused by
  check-dist on its own (K4).

**`FULL_CATALOG_GZ`** is now only a ceiling on the budget constants. See M-1.

**The messages.py estimate without node** is not a weakening:

- Its threshold is 5% below each budget, which is stricter.
- CI installs node, so it measures exactly.
- check-dist's exact per-part check runs on CI's prod build either way.
- The output says "estimated without node" when it estimates.

**Settings-page loads on first paint:** two chunk files for an empty profile, six unlocked, seven locked, against one
before. Only the wizard's and the lock's parts are lazy. I did not time this in a browser.

### D. Mutants

**Mine** (`tools/mut.py`, each applied alone in `mut/` and reverted; output in `mutants.log`). 16 of 20 were killed:

| ID   | Mutant                                                                        | Killed by                                                                                                 |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| K1   | check-dist core budget below the measured size                                | check-dist                                                                                                |
| K2   | a part's budget above 12 KB                                                   | check-dist; budget-split                                                                                  |
| K3   | messages.py and check-dist budgets disagree                                   | budget-split                                                                                              |
| K4   | core text past its budget (an OVERRIDE of 2,000 CJK characters)               | messages.py; then check-dist on the build                                                                 |
| K5   | in Guide (general), ``t(`backup${n}`)``, a family reaching backup's keys      | budget-split ("general uses backupLead, placed in backup")                                                |
| K6   | App passes `title="backupTitle"` to Guide, which draws `t(p.title)`           | collector rule 6: "Guide is exported by the part's entry … drawn from outside the part"                   |
| K7   | a backup-only key (`ungrouped`) placed in misc and regenerated                | budget-split (messages.py accepts it, correctly: it is only data)                                         |
| K8   | `src/ui/errors.ts` value-imports VaultService, so the popup reaches service.ts | budget-split, i18n-popup, m2-source-rules (graph tests). The popup-folder regex alone would miss it      |
| K10  | `startSession` made public                                                    | budget-split protected list; tsc (POPUP_API)                                                              |
| K10b | the `session` field made public                                               | budget-split protected list; tsc                                                                          |
| K15  | `hardLock` and `endQuickQuietly` moved back into ServiceCore                  | budget-split member lists                                                                                 |
| K16  | `ServiceCore.unlockWith` no longer records a wrong secret                     | service.test.ts lock-screen recording test (security-log and security-notice alone do not catch it)       |
| K17  | App.reload calls setStatus before loadParts                                   | budget-split                                                                                              |
| K18  | main.tsx renders before core loads                                            | budget-split; i18n-popup                                                                                  |
| K19  | popup/App.tsx uses `createRuntime` from platform/runtime                      | budget-split; m5-source-rules                                                                             |
| K20  | popup/load.ts imports `partsFor` from options/parts.tsx                       | check-dist: 16 × "the popup can load the settings page's catalog …" (popup 108.8 KB). The build passed     |

The four that survived:

| ID   | Mutant                                                        | Reported as |
| ---- | ------------------------------------------------------------- | ----------- |
| K9   | a second ServiceCore subclass reads `this.session`            | m-1         |
| K11  | `ready.add` before the text is merged                         | m-3         |
| K11b | `ready.add` at request time, before the fetch                 | m-3         |
| K12  | no English fallback for a part                                | m-3         |

There was also one control: K5a, ``t(`guide${n}`)`` in Guide, a family that stays in its own part. It correctly passed.

On K16: `mutants.log` shows it as SURVIVED. That first run was against security-log and security-notice, which do not
cover the lock screen's recording. K16b is the same mutant run against service.test.ts, and it is killed there.

**The implementer's mutants, re-run:** K13 is their L1-6 (the wrapper draws before its text is in), killed by
budget-split. K14 is their L2-3 (the popup runtime builds VaultService), killed by budget-split and m5-source-rules. I
did not re-run their other 17.

### E. Crypto, storage and sync semantics

There is no change to any crypto, storage or sync code path:

- `service-core.ts` and `service.ts` hold the original members verbatim.
- `sync-flows.ts`, `pin-admin.ts`, `store.ts` and `keyring.ts` are untouched.
- The runtime wiring is identical apart from the class factory, comments and imports.
- The popup now builds a class without the settings-only methods. Its own calls are unchanged, and so are its read
  budgets (read-budget, quick-read-budget and read-budget-sync, now measured on `createPopupRuntime`, all pass in the
  full run).

## E2E

121 of 121 passed, run serially with Playwright (workers=1) on the patched tree's own `dist-e2e`, in two runs:

- **The options-page specs, 37 passed in 1.4 minutes:** firstrun (an empty profile: the core and firstrun parts),
  reset (the locked settings page with the unlock part), security-log, guide, errors, presets, and quick-pin (which
  includes "a locked settings page").
- **Every other spec in test/e2e and test/regression, 84 passed in 5.6 minutes**, except three.

The harness's i18n guard turns any key without text into a failed test, so no settings view the suite reaches showed a
key name. That is runtime evidence that the placement and the loader work on the views covered.

`build:e2e` and `check-dist --e2e` passed first.

The three specs not run need 127.0.0.1:8787, which an unrelated process (`mttick-se`) holds:
`test/regression/network.spec.ts`, `page-csp.spec.ts` and `permission-wire.spec.ts`. They hold the 4 remaining tests of
the implementer's 125.

## Not checked

- **Three e2e specs.** `network`, `page-csp` and `permission-wire` (4 tests) were not run, because port 8787 was taken.
  The dev build that `permission-wire` uses was not built either.
- **`npm run e2e:sync`,** which needs the real API server and PostgreSQL.
- **First-paint timing** of the settings page in a browser; m-4 is from reading the code. No Chromium 120/134 run.
- **The 401-key placement**, line by line. I relied on the collector test, my partition and text-equality check, the
  grep of unplaced keys, and the build plugin's union check.
- **The emitted JavaScript** of the two classes against the old one (AST member equality only).
- **The implementer's other 17 mutants.**
- **The collector's pre-existing blind spot** (a key written into a module-level table outside a part and read
  inside). I did not construct a case for it; the notes acknowledge it.

## Verdict

**Merge after fixes.**

- **Before merging:** M-1. Either add the aggregate first-paint check, which passes today, or record the higher total as
  an owner decision and correct "No limit was raised".
- **Cheap, worth doing together:** m-1 (the subclass rule) and m-2 (drop the vault before waiting on a part).
- **Can follow:** m-3 (loader tests), m-4 (prefetch), m-5 (docs).
- **The service split itself** is a clean, verified pure move and could merge as it is.
