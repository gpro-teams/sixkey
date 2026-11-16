# Budget relief: the popup's service, and the settings page's text in parts

Two hard size limits were nearly used up, and every further feature hit one of them:

- **The popup's budget** (`BUDGET_GZ`, 61,440 B gzipped, scripts/check-dist.mjs). The store build shipped 60,394 B.
  With the sync user interface's release gate open it was 61,287 B, leaving 153 B.
- **The full catalog's limit** (`FULL_CATALOG_GZ`, 12,288 B), which applied to the settings page's catalog. The zh_CN
  catalog was 12,233 B, leaving 55 B. The Sync section's own catalog was at 11,888 B of its 12,288 B.

No limit was raised. Two changes make room. The first takes the settings page's key operations out of the popup's
bundle. The second loads the settings page's text in parts, each part with its own budget. The behaviour of both pages
is unchanged.

The old limits still hold on the measure they were set on. Each view of the settings page loads several parts; those
parts, as one gzip stream, are held to the 12 KB the text had as one catalog. Every part at once is held to it too, and
so are the Sync section's two catalogs together. The per-part budgets come on top of that (§2, "Budgets"). The Sync
section's text therefore gains no room. Together its two catalogs are 11,885 of 12,288 B, the same as before the split.
More room for it is the owner's decision (§5).

## 1. The popup builds only the part of the service it uses

### Structure

- `core/service/service-core.ts`, `class ServiceCore`. This is what the popup uses:
  - `openView`, `unlockWithPassword`, `unlockWithRecoveryCode`, `unlockWithPin`, `mutate`, `ackEvents`, `lock`, `touch`;
  - the steps these take: the session, arming and checking the PIN, the input hint, the security record, and the one
    key-change cleanup entry point `finishKeyChanges`;
  - the types the popup and the constructor need (`ServiceDeps`, `SyncPort`, `VkRecord`, `OpenView`, ...);
  - `isSessionExpired`;
  - `hasDevice`, now exported so that service.ts uses this predicate rather than a copy of its own. pin-admin.ts keeps
    the copy it already had.
- `core/service/service.ts`, `class VaultService extends ServiceCore`. This is everything else:
  - the first run (`prepareKeys`, `create`, `restoreBackup`, `startOver`);
  - the key operations (`enableMasterPassword`, `rotateKey`, `changePassword`, `prepareReset`, `commitReset`,
    `newRecoveryCode`) and their `committed` cleanup;
  - `verifyPassword`, `requireMasterPassword`, `recordExport`, `clearSecurityLog`;
  - `status`, `read`, `getSettings`, `updateSettings`, the hard lock;
  - `importBackup`, `purgeForever`, `lastBackupAt`, `markBackedUp`, `methods`, `currentGeneration`;
  - the service worker's `enforceAutoLock` and `enforceQuickExpiry`.

  The module-level handles (`preparedKeys`, `preparedResets`, `LANDED`) stay here, one copy each. service.ts exports
  everything it exported before, and the moved types and helpers are re-exported from it. Every existing caller is
  unchanged: the settings page, the service worker, the developer page, `SyncFlows`, `PinAdmin` and the 31 test files
  that build a `VaultService`.
- `platform/runtime-base.ts`. This is the wiring every context shares (storage, the session, the security record, the
  PIN's set-up, sync's light side and the outbox):
  - `buildRuntime(o, make)` is the old `createRuntime` body, with `new VaultService(...)` replaced by `make(...)`;
  - `createPopupRuntime()` builds it with `ServiceCore`;
  - `keysChangedElsewhere` moved here as well.

  `platform/runtime.ts` keeps `createRuntime()`, which now builds the wiring with `VaultService`, and it keeps its old
  exports. The popup imports runtime-base.ts only.

### Pure move

- Every class member was moved by a script that copies its text verbatim. The script checks that its parse rebuilds the
  original class byte for byte, and that each original member appears exactly once across the two files.
- The only edits to moved code are visibility: `private` became `protected` on 18 members, the 12 fields and the 6
  steps `currentVk`, `requireVk`, `startSession`, `saveFormat`, `record`, `finishKeyChanges`. This changes
  TypeScript only; the emitted JavaScript is the same.
- `VaultService` declares no fields, because with class-field semantics a field there would be set again after the base
  constructor.
- To review: `git diff --color-moved=zebra` shows the moved blocks.
- `test/unit/budget-split.test.ts` pins several things:
  - both classes' member lists, which must add up to the 66 methods and accessors of the original class (80 members with
    its 13 fields and the constructor);
  - service.ts's exports;
  - the protected list, and that `VaultService` declares no fields;
  - that `VaultService` is the only class extending `ServiceCore`, nothing extends `VaultService`, and only service.ts
    and runtime-base.ts import `ServiceCore`. Making members protected must not open a second way to them, such as the
    session cache, beside the element access m2-source-rules allows in sync-flows.ts and pin-admin.ts;
  - the single handles;
  - that the popup graph holds `service-core.ts` and `runtime-base.ts`, and does not hold `service.ts`, `runtime.ts`, the
    password policy, the presets, the previous-key cap, `PinAdmin` or `SyncFlows`.
- A type-level check, `POPUP_API`, fails `npm run typecheck` when `ServiceCore` gains a public method that is not on the
  list. CI runs typecheck; vitest erases types and cannot run this check.

### Tests that moved with the code

- The source rules that named service.ts or runtime.ts now name the file that holds the code. None was weakened, and
  several gained a negative check. The affected tests are source-rules, m2/m3/m5/quick source rules, password-entry-service,
  sync-crypto-hygiene and i18n-popup.
- The popup's read budgets (read-budget, quick-read-budget and read-budget-sync) now measure `createPopupRuntime`, the
  popup's real wiring. `status()` and `read()`, the reference path, still use `createRuntime`.
- The fault and crash suites build `VaultService` exactly as before.

## 2. The settings page's text, in parts

### Structure

- **Parts.** `scripts/catalog-keys.mjs SETTINGS_PARTS` lists each part's entry modules:

  | Part       | Entry modules                         |
  | ---------- | ------------------------------------- |
  | `security` | Security.tsx                          |
  | `accounts` | AddAccounts.tsx                       |
  | `backup`   | Backup.tsx                            |
  | `misc`     | Misc.tsx (Trash, Clipboard, Advanced) |
  | `general`  | Appearance.tsx, Guide.tsx             |
  | `firstrun` | FirstRun.tsx                          |
  | `unlock`   | UnlockBar.tsx, Reset.tsx              |

  `core` is the rest of the page: the frame, the rail, the install notice, and the words two or more parts share.
- **Catalogs.** Each part has `catalogs/settings-<part>-<lang>.json`, written by `scripts/messages.py`. Each is its own
  chunk, `assets/settings-locale-<part>-<lang>-*.js`. No page loads the full catalog (`_locales`) any more. Chrome
  still reads it, for the manifest's `__MSG_` names and `chrome.i18n.getMessage("syncBadgeTitle")`. The popup's
  catalog is still cut from it at build time, as before.
- **Which key goes in which part** is data: each fragment's `PARTS = {part: [keys]}`. scripts/i18n/budget.py places the
  existing 401 keys. It was taken from the code's own use (`node scripts/catalog-keys.mjs --settings`): a key the frame
  or two or more parts use goes to core, any other to the one part that uses it. The other 96 keys are the popup's or
  Chrome's (`appName`, `appDesc`, `cmdLock`, `syncBadgeTitle`).
- **The loader** is `src/options/parts.tsx`:
  - `main.tsx` loads the core before it draws anything.
  - `App.reload()` waits for `partsFor(state)` before it shows a new state, and only when those parts are not in yet. A
    vault that exists (unlocked, locked or lost) gets the main sections and the lock's part (`unlock`, 683 B in zh_CN).
    An empty profile gets `firstrun`.
  - A page with a vault holds the lock's text from the start. So when Sixkey locks anywhere, `setStatus` follows
    `status()` with nothing awaited between them, and the page drops its vault as soon as it did before (QUICK-UNLOCK
    §5.12 item 3).
  - The section parts start loading only once `status()` has answered, not alongside it. They are local extension
    files, and the delay was not measured in a browser. Loading them alongside `status()` would load five parts for an
    empty profile, and would put a wait back into the lock path, so it was left out.
  - So the sections are drawn whole, the rail's IntersectionObserver finds them, and `#security`, `#reset`, `#setup` and
    `#install` work as before.
  - Every part component is drawn only through its wrapper (`gated(part, Component, sectionId)`). Until its part's text
    is in, the wrapper draws nothing, or, for a section, its empty `<section id=… aria-busy="true">`.
  - The text is never drawn before it loads, so no key name can flash.
  - The views the page reaches later (the wizard from Advanced or Backup, the reset from the unlock bar) load their part
    when they are drawn.
  - Loading never rejects. It falls back to English, then to key names, as `loadCatalog` does. The fallback is per part:
    if only one part's zh_CN chunk cannot be loaded, that part is shown in English and the rest in Chinese. Before, the
    whole page fell back together.
  - `i18n.ts` is unchanged. The loader passes `loadCatalog` the text of the parts loaded so far, so the popup's bytes do
    not change.
- **The Sync section's text** is two files:
  - `catalogs/sync-<lang>.json`, from SYNC_EN and SYNC_ZH;
  - `catalogs/sync-manage-<lang>.json`, the managing screens', from m6b.py's tables, now named SYNC_MANAGE_EN and
    SYNC_MANAGE_ZH. This is the second catalog M6-NOTES named.

  `src/options/sync/text.ts` fetches both side by side before the section draws. The words the section takes from `t()`
  are in core.

### Rules

- The key collector has a new rule 6: `stop`, `part` and `pageCatalogs`.
  - A part's run fails closed when a lookup reaches a parameter of a function its entry exports, because the page passes
    it values that cannot be seen from inside the part.
  - The fixtures are in `test/unit/i18n-collector.test.ts`.
- test/unit/budget-split.test.ts:
  - every key a part's code can show is in core or in that part, and the frame's keys are in core;
  - every placed key is used there;
  - every key of the full catalog is reachable: placed in a part, or the popup's, or Chrome's;
  - the parts are disjoint, have the same keys in both languages, and carry the full catalog's text;
  - the part list and the budgets agree across the collector, messages.py, check-dist and parts.tsx;
  - each part's two imports, and each wrapper's part;
  - only parts.tsx imports a part's entry, and no part imports another part's entry;
  - the load order: only `["core"]` at start, and `reload()` waits before `setStatus` only when the parts are missing;
  - `partsFor`;
  - the view lists, which must match in check-dist, messages.py and `partsFor`;
  - the loader's behaviour;
  - messages.py's refusals.
- test/unit/budget-loader.test.ts runs the loader against mocked chunks. Some arrive late, some fail in Chinese, some
  fail in both languages. It checks three things:
  - a part never counts as loaded before `t()` has its text;
  - the English fallback works;
  - a part that loads in neither language leaves key names, and nothing rejects.
- scripts/build.mjs, which shares no code with the collector:
  - no `_locales` file is in the settings page's graph;
  - each settings catalog is a chunk of its own, reached by `import()` only, for every part and language;
  - every quoted key in the code of each chunk the page can load is in a settings catalog;
  - the gate-closed guard also forbids `catalogs/sync-manage-*.json`.
- scripts/check-dist.mjs:
  - exactly one chunk per part and language, and strays fail;
  - no `assets/locale-*.js` (a chunk of a full catalog);
  - each part within its budget, in the prod and e2e builds;
  - each view's parts, as one gzip stream, within `FULL_CATALOG_GZ` (`SETTINGS_VIEWS`, below), and the Sync section's
    two catalogs within `SYNC_CATALOG_GZ`;
  - each part equals its generated file and carries `_locales`' text, and the parts are disjoint;
  - the settings page reaches each part and preloads none of them; the popup reaches none;
  - every `getMessage` key in a shipped script has text in every locale;
  - the Sync section's rules now cover both of its catalogs.
  - `test/unit/budget-check-dist.test.ts` tampers with real builds, one rule at a time, and also covers the build's own
    rules.
- scripts/messages.py:
  - refuses a key placed twice, a part that does not exist, or a placed key that is removed, the Sync section's, or not a
    key at all;
  - refuses a manifest `__MSG_` name or a `getMessage` key with no text;
  - refuses a catalog over its budget, and a view's catalogs together over 12 KB (`AGGREGATES`). It refuses before it
    writes any file.
  - Sizes are measured with Node's gzip on the exact chunk text, so they match check-dist.
  - Without node, messages.py estimates with Python's zlib, which comes out up to 3.1% smaller, and stops 4% short of
    each limit. It says so in its output.

### Budgets and measured sizes

The sizes are gzipped bytes of the built chunks. The budgets are in messages.py `BUDGETS` and check-dist
`SETTINGS_CATALOG_GZ`, and a test keeps them equal. Each part's budget is its measured size, plus at least 1.5 KB,
rounded up to 512 B, and no budget is above the old 12 KB.

| Catalog                      | Before (en / zh_CN)    | After (en / zh_CN) | Budget   | Headroom |
| ---------------------------- | ---------------------- | ------------------ | -------- | -------- |
| full (the settings page's)   | 10,826 / 12,233        | not loaded         | (12,288) | -        |
| settings core                | -                      | 2,992 / 3,462      | 5,120    | 1,658    |
| settings security            | -                      | 2,725 / 3,311      | 5,120    | 1,809    |
| settings accounts            | -                      | 1,195 / 1,445      | 3,072    | 1,627    |
| settings backup              | -                      | 938 / 1,151        | 3,072    | 1,921    |
| settings misc                | -                      | 903 / 1,093        | 3,072    | 1,979    |
| settings general             | -                      | 1,057 / 1,343      | 3,072    | 1,729    |
| settings firstrun            | -                      | 763 / 953          | 3,072    | 2,119    |
| settings unlock              | -                      | 532 / 683          | 3,072    | 2,389    |
| sync                         | 10,754 / 11,888        | 7,642 / 8,544      | 12,288   | 3,744    |
| sync-manage                  | -                      | 3,821 / 4,322      | 12,288   | 7,966    |
| popup (gate closed)          | 3,546 / 4,174          | 3,535 / 4,159      | -        | -        |
| popup (gate open)            | 3,710 / 4,370          | 3,699 / 4,357      | -        | -        |

| Popup bundle (gzipped)   | Before | After  | Budget | Headroom |
| ------------------------ | ------ | ------ | ------ | -------- |
| store build, gate closed | 60,394 | 57,438 | 61,440 | 4,002    |
| store build, gate open   | 61,287 | 58,301 | 61,440 | 3,139    |

What the page loads together is held to the old limit, as one gzip stream: each view's chunks concatenated in load
order (check-dist `SETTINGS_VIEWS`, messages.py `AGGREGATES`).

| Loaded together                              | en / zh_CN      | Limit  | Headroom |
| -------------------------------------------- | --------------- | ------ | -------- |
| settings page, no vault (core, firstrun)     | 3,543 / 4,106   | 12,288 | 8,182    |
| settings page, a vault (core, five, unlock)  | 8,714 / 9,817   | 12,288 | 2,471    |
| settings page, every part                    | 9,162 / 10,339  | 12,288 | 1,949    |
| the Sync section (sync, sync-manage)         | 10,766 / 11,885 | 12,288 | 403      |
| before: the full catalog, one chunk          | 10,826 / 12,233 | 12,288 | 55       |
| before: the Sync section's catalog, one      | 10,754 / 11,888 | 12,288 | 400      |

The settings page's room under the old measure grows from 55 B to at least 1,949 B. Most of that comes from leaving out
the 96 keys only the popup and Chrome use. The Sync section's room stays where it was.

## 3. Adding a string

1. Put the text in your package's own fragment, `scripts/i18n/<package>.py`, as `EN` and `ZH`, as before.
2. If the settings page shows it, place it in the same fragment with `PARTS = {"<part>": ["yourKey"]}`. Use the part
   whose module uses it, or `"core"` when the page's frame or two or more parts use it. To find which, run
   `node scripts/catalog-keys.mjs --settings`, which prints where the code uses each key. A popup-only key needs no
   placement. A Sync section string goes in `SYNC_EN`/`SYNC_ZH`, or in `SYNC_MANAGE_EN`/`SYNC_MANAGE_ZH` for the
   managing screens.
3. Run `python3 scripts/messages.py`. It needs node to measure exactly; without node it estimates and stops 4% short.
   It prints every catalog's size against its budget, then what each view loads together against 12 KB. It refuses one
   over its limit, and then writes nothing.
4. Run `npx vitest run test/unit/budget-split.test.ts`. It reports any difference between the code and the placement:
   - "`<part>` uses `<key>`, placed in `<other>`" means the key must move to `<part>`, or to core if another part uses it
     too. "Placed in no part" means it was never placed.
   - "`<part>: <key>`" under "every placed key is used" means the code no longer uses it there. Move it, or remove it with
     `REMOVE`.
   - "is exported by the part's entry … drawn from outside the part" means a part's exported component passes a prop it
     receives to `t()`. The page's key cannot be seen from inside the part, so pass text, or use a key the part names
     itself.
5. To move an existing key, edit the `PARTS` entry that places it (most are in scripts/i18n/budget.py).
6. A new part means four changes, kept equal by the tests:
   - its entry in `SETTINGS_PARTS`;
   - its two imports and its wrappers in parts.tsx;
   - its name in messages.py `SETTINGS_PARTS` and its budget in `BUDGETS`;
   - its budget in check-dist `SETTINGS_CATALOG_GZ`.

Applying a patch: catalogs and `_locales` are generated, so a patch leaves them out. After applying one, run
`python3 scripts/messages.py` and commit what it writes. CI builds before it regenerates the catalogs, and then fails
when one differs, or when one is new and uncommitted.

## 4. Verification

Revision 2 follows an independent review of revision 1. The review's report is not part of the tree. It found no
blocker. Its findings, and what this revision did about each:

- M-1: the aggregate limits above.
- m-1: the subclass rule.
- m-2: a lock waits for no text.
- m-3: the loader's tests.
- m-4: written down here, not changed.
- m-5: docs/ARCHITECTURE.md corrected.
- The trivial NITs:
  - the Sync section's two catalogs are fetched side by side;
  - messages.py checks before it writes;
  - CI also fails on an uncommitted generated catalog;
  - these notes are corrected.

Results:

- **Unit.** The whole vitest suite ran once, in a fresh copy of the live tree with this patch applied and the catalogs
  regenerated. It includes the fault, crash and regression suites. 183 files; 2,572 passed, 4 expected failures,
  1 skipped. The baseline was 180 files and 2,510 passed, with the same 4 expected failures and the same skip.
- **Mutants.** 50 hand-made mutants, each applied alone and reverted. 49 were killed. The 50th is a control that must
  survive, and did.
  - L1-1 to L1-14 and L2-1 to L2-5: the 19 of revision 1, with the anchors moved where the code moved. All killed. L1-14
    is also killed by the unit test of the Sync section's two-file load.
  - K1 to K20 and K16b: the reviewer's. All killed, including K9 (a second `ServiceCore` subclass reading the session)
    and K11, K11b and K12 (the loader's ordering and fallback), which survived revision 1. K5a, a template family within
    its own part, is the control that must pass.
  - R1 to R8: this revision's. They are:
    - R1, R2: check-dist's view aggregate off, and its Sync section aggregate off;
    - R3: check-dist's view of a vault without the lock's part;
    - R4, R5: messages.py's aggregate off, and messages.py writing before it checks;
    - R6: `partsFor` without the lock's part for an unlocked vault;
    - R7: `reload()` awaiting parts that are already in;
    - R8: messages.py's view of a vault without the lock's part.
    All killed.
- **e2e.** `npm run e2e` ran once, serially, in a copy of the patched tree. The copy's path holds no `/e2e/`, so the
  real-server specs of test/sync stay out. In that copy only, the API port moved from 8787 to 18787, because an
  unrelated program holds `*:8787`. Result: 125 of 125 passed, covering every spec in test/e2e and test/regression. check-dist passed on the prod, e2e and dev builds.
  `npm run e2e:sync` needs the real API server and its PostgreSQL, and was not run.
- **Gate open.** The store build with the release gate open (a private copy, as m6-gate.test.ts builds it) passed its
  own check-dist. The popup was 58,301 B, and the Sync section's text together was 11,885 B in zh_CN.

## 5. Limits and open points

- The per-part budgets are this change's own numbers, and they are the owner's to confirm. They come on top of the
  12 KB that each view's text together, and every part at once, still have.
- The Sync section has 403 B of room on the old measure (its two catalogs together). More text for it needs either an
  owner's decision to raise that combined limit, which the split alone would allow, or shorter text.
- The main sections' parts and the lock's part load for every vault that exists, because the page draws them at once and
  a lock must not wait. Only the wizard's part is lazy for a vault.
- The popup's catalog lost one key, `changePassword`. It was only mentioned in the popup's code, as the name of a
  `VaultService` method, and was never drawn. This is where the popup catalog's 11 to 15 B went.
- The collector's remaining blind spot is a key written into a module-level table by code outside a part's graph, and
  read inside it. The rule 6 boundary does not see it, and the end-to-end i18n guard is the only backstop: it reports a
  key with no text on screen as a failed test.
- messages.py now runs `node` to measure exactly. Without it, the estimate stops 4% short of each limit.
- Other popup savings, not taken because the target is met:
  - keyring.ts's key-operation functions and vault/ops.ts's settings-only operations, which the popup's shared chunk
    carries because the settings page uses them. Moving them means moving crypto and vault-model code.
  - The icon table, shared by both pages.
  - A popup-only build measured 53,195 B, which bounds what more splitting could save at about 4 KB.

## 6. A lazy catalog part of the popup: the View menu (QUICKVIEW-NOTES.md)

The settings page's text is in parts that load before their part is drawn; the popup gets the same for a menu it opens on
demand. `src/popup/main/View.tsx` is loaded on the first click of the search field's View button, with its own catalog:

- **Data.** `catalogs/view-<lang>.json`, written by `scripts/messages.py` from the fragments' `VIEW` lists (keys of the full
  catalogs, new or existing; an existing key is listed again, not moved, because the settings page keeps loading its own
  text). Its budget is 2,048 B gzipped (measured 356 B, the larger language), in `messages.py` BUDGETS and check-dist's
  `VIEW_CATALOG_GZ`, which `budget-split.test.ts` holds equal. It is no part of `AGGREGATES`: no page loads it with others.
- **Keys.** `catalog-keys.mjs` stops the popup's walk at `VIEW_ENTRIES` (rule 6), so the menu's words are not in the counted
  popup catalog, and `viewKeys` works out what the module can show, as `settingsKeys` does for a part. The build fails if
  that is not in the menu's file or the popup's catalog, and `view-catalog.test.ts` fails if the file holds a key the menu
  does not use. The menu keeps its text in a lookup of its own, never in the page's catalog (`i18n.ts` is unchanged), so a chunk that cannot be
  loaded costs the menu its words and the page nothing; its two keys the popup has (`errorTitle`) it reads from the page.
- **Chunks.** `assets/view-locale-<lang>-<hash>.js` and `assets/View-<hash>.js`. The build refuses either in the static graph
  of the popup or the side panel; check-dist refuses them in any page's HTML, requires them reachable from the popup and the
  panel by `import()` and from no other page, one chunk per language, exactly the generated file.
- **The popup's counted bundle is sensitive to what a lazy chunk imports.** Chunks are formed by which entries reach a
  module, and each is gzipped alone; a lazy module that reaches only part of a shared group splits it (QUICKVIEW-NOTES §4:
  the icon table, +400 B; a value import from `core/service/types.ts`, +300 B). A new lazy popup module should be built
  and measured with the gate open (`SYNC_UI_IN_STORE_BUILD = true` in a private copy) before it is trusted.
- **What moved to make room**: the "Add account" view and its styles (−551 B) is loaded on first use; the popup went from
  59,904 B to 59,732 B with the sync user interface in (headroom 1,708 B).

## 7. A lazy catalog of the settings page: the recovery key shares (SHAMIR-NOTES.md §6)

The shares' text (`catalogs/shares-<lang>.json`, budget 3,072 B) is loaded with the shares' lazy chunks by the popup, the
side panel and the settings page, so it is outside the 12,288 B aggregates, as the popup's lazy catalogs are (the
owner's decision, 2026-10-23). What a vault's page holds with it in, its view's parts and the shares' catalog as one gzip
stream, is held to **15,360 B** (12,288 + 3,072): `messages.py` `SHARES_PAGE_LIMIT` and check-dist `SHARES_PAGE_GZ`,
equal by `shares-check-dist.test.ts`. Measured at 12,750 B (zh_CN). The "every part" aggregate itself has about 200 B left
(12,090 of 12,288 B in zh_CN): the next feature's settings text needs a lazy catalog of its own, or text moved out.

The recovery code's rename to the recovery key (OWNER-DECISIONS/16 question C, 2026-10-23; `scripts/i18n/recoverykey.py`)
adds one character to every Chinese use; gzip takes almost all of it, and the English is a little shorter. Measured by
check-dist, zh_CN, before and after: the every-part aggregate 12,094 → 12,097 B (191 B left), a vault's page with the
shares' text 12,848 → 12,857 B of 15,360, the shares' catalog 1,779 → 1,785 B of 3,072, the Sync section 11.6 KB (the
messages.py measure 11,885 → 11,891 B) of 12,288; the popup unchanged, 57,818 B with the release gate open (56,585 B
closed) of 61,440. No text was moved.

## 8. What the 15,360 B check of "every lazy catalog" counts (budget work 3, BUDGET3-NOTES.md)

The check check-dist prints as "a vault's page with the plugins' text and every other lazy catalog in" (messages.py
`PLUGINS_VIEW`) counts a vault's view (the core and its six parts) with the four lazy catalogs the settings page can
load: the shares', the device unlock's, the plugin platform's and the PIN after a restart's. It extends the owner's rule
for the shares' catalog (§7, SHAMIR-NOTES.md §6) to the catalogs added since; it is not the most one page can hold. A
vault's page can also draw the first-run wizard (Backup's restore, Advanced › Start over), which loads the firstrun part:
with it, the page holds 15,783 B (zh_CN at 539e9f6; 15,776 B after budget work 3), which no limit holds. The rule is
unchanged; the comments in messages.py and check-dist now say what it counts.

Budget work 3 made room under it for two features' text without changing a rule or a word on screen: four keys whose
text another key has in both languages merged into that key, and the never-shown labels of two kinds reserved for the
YubiKey features (and never recorded) removed. The check went from 15,265 to 15,258 B (zh_CN) with the new text in, the
"every part" aggregate from 12,112 to 12,116 B of 12,288. The popup's and the side panel's counted bundles shrank by
about 165 B: the security record's list of kinds' names left them (BUDGET3-NOTES.md §5.1).

## 9. Room before the alias suggestions: what the popup and the side panel never draw, out of what they count (AF3-4t)

TOTP autofill Stage 3's alias suggestions (AF3-4) will add up to 200 B to the popup's and the side panel's counted bundles.
The owner's floor, 1,500 B of headroom (AUTOFILL1-NOTES.md §6), holds for the side panel too (the maintainers' C23), and
is measured on a store build with both release gates open: the sync user interface's and the in-page suggestion's (4d,
whose one code line is `SUGGEST_UI_IN_STORE_BUILD = true` in `scripts/suggest-ui.mjs`). Measured at `6f330fd`, that build
had both pages under the floor already: the popup 60,087 B of 61,440 (147 B short), the side panel 62,328 B of 63,488
(340 B short). This patch moves out of the counted files what neither page ever draws, and nothing else. No limit, no
text and no screen changed. These notes are kept here because this file is where the popup's budget relief is written
down (§1, §6, §8); `AUTOFILL3-NOTES.md` §6 points here.

**What moved.**

- **The settings page's chips and code box.** `.chip` (and its `:empty`, `::before`, `.ok`, `.warn`, `.bad`) and
  `.code-box` (and its `::after`, `i`) were in `src/ui/styles.css`, which the popup and the side panel load too. Only the
  settings page's modules draw them (class attributes in `src/options/` only). They are now in `src/options/base.css`,
  which `src/options/main.tsx` imports right after `../ui/styles.css`, so the settings page meets them where it did; the
  one rule that followed them in `styles.css`, the reduced-motion one, sets only animations, transitions and scrolling,
  which these do not. `popup.css`'s `.center .code-box` had no box to style (no popup screen draws one) and is gone.
- **The Add view's choices.** The view's twelve rules (`.opts`, `.opt` and its hover, `.oi`, `.ot`, `.chev`,
  `.opts-foot`) were in `src/popup/popup.css`; only `AddMenu.tsx` draws those classes. They are now at the head of the
  view's own `add.css`, which loads with the view's lazy chunk: the bundler's preload appends the stylesheet and waits for
  its `load` before the view's code runs, so the view is never drawn without them. In the cascade they now come after
  the edit sheet's rules, `.pair`, the keyframes and (in the side panel) `panel.css`, which none of the view's elements
  match except `body.panel .opts`, more specific and setting only `order`, which the view's rules do not set.
- **The settings page's own icons.** `link`, `file`, `moon`, `dice`, `enter`, `pulse`, `archive` and `sync` left the shared
  icon table (`src/ui/icons.tsx`) for `src/options/icons.tsx`. The shared `Icon` draws them from their path (its new `d`
  prop), on the same grid and pen; every module of the settings page takes `Icon` from `./icons`, which knows both sets.
  The shared `IconName` no longer has these names, so a popup module that drew one would not compile.

**What each build counts, before (`6f330fd`) and after** (check-dist; the store build four ways; "above the floor" is the
limit less the total less 1,500 B):

| Release gates | Popup | Above the floor | Side panel | Above the floor |
| --- | --- | --- | --- | --- |
| as shipped (both closed) | 59,101 → 58,226 (−875) | 839 → 1,714 | 61,343 → 60,467 (−876) | 645 → 1,521 |
| sync open | 59,658 → 58,790 (−868) | 282 → 1,150 | 61,896 → 61,026 (−870) | 92 → 962 |
| in-page suggestion (4d) open | 59,515 → 58,640 (−875) | 425 → 1,300 | 61,755 → 60,884 (−871) | 233 → 1,104 |
| **both open** | **60,087 → 59,218 (−869)** | **−147 → 722** | **62,328 → 61,455 (−873)** | **−340 → 533** |

With both gates open, the shared stylesheet lost 373 B gz (the chips and the code box), the popup's own 218 B (the Add
view's rules and the dead rule), the shared script 274 B (the eight icons, less the few bytes of `d`); the catalogs did
not move. After AF3-4's 200 B, the popup keeps 522 B above the floor and the side panel 333 B. The lazy files grew where
the rules went: the Add view's stylesheet 377 → 779 B gz, the settings page's stylesheet 6,439 → 6,699 B and script
49,287 → 49,721 B (none of them counted, the settings page's code in no budget).

**What holds it.** check-dist refuses a rule of `src/options/base.css` or `src/popup/main/add.css` in any stylesheet the
popup or the side panel counts (compared by selector, as the minifier writes it), and a path of `src/options/icons.tsx`
in any script they count; and each must still ship outside them (so a change of form cannot pass by matching nothing).
It prints "kept out of the popup's and the side panel's counted files: 29 rules (…), 8 icons (…)".
`budget4t-check-dist.test.ts` holds the sources (each rule and icon in one place, drawn only where it lives; the settings
`Icon` draws its own icons by path and the shared ones by name), a real store build (none of them counted, each where it
lives, the Add view's stylesheet in the preload of its chunk, the preload waiting for the stylesheet), and check-dist on
altered copies (a rule back in each counted stylesheet, an icon back in the shared script, a rule lost: each refused).
`add-popup.spec.ts` checks in Chromium that the view's first choice is styled in the first frame it exists in.

**Options left for later** (measured on `6f330fd`, both gates open, estimates from the built files; not built):

- **The Add view's and the account dialogs' text in a lazy catalog of their own** (AddMenu, AddConfirm, EditDialog,
  Remember: 69 keys), as the View menu has (§6): the counted popup catalog −2,985 B (zh_CN; en −2,558), the new catalog
  about 2,364 B gz; the Add view's text alone (49 keys) −2,046 B. It costs one more local fetch at the first Add, paste,
  Edit or Remember of each opening of the popup, and the edit dialog's words stay in the popup's catalog on purpose
  (`Main.tsx`).
- **Code only the lock, welcome and status screens draw, in their lazy chunk**: the vault dial (`ui/art.tsx`
  `VaultDial`, −280 B), and eleven icons only lazy popup modules draw, in a lazy table (−358 B). No more requests, but the
  chunk a locked popup loads at opening grows by a few hundred bytes.
- Not proposed: the lock screen's text (−1,252 B, a fetch at a locked opening), the error texts (−1,244 B, failure paths
  that include the status screen at opening), the security record, the PIN, the sync records and the store (the service
  core), the clipboard (the first click), and two tiny chunks (about 40 to 70 B of gzip overhead, the bundler's chunking).

**Checks** (`6f330fd` with this change, through the shared runner; vitest with two workers, Playwright with one):
messages.py changes nothing (44 generated files); typecheck, format and notices clean; the store, e2e and dev builds pass
check-dist, and the store build each of the four ways above; in each page's stylesheets in the order the browser meets them (the
popup and the side panel with the Add view open), the only differences are the rules taken out and the Add view's block
moved as above, and on the settings page the reduced-motion rule now before the nine moved rules instead of after;
the full unit run (346 files: 5,621 passed, 4 expected to fail, 1 skipped); in Chromium `visual-guard` (every popup
screen, the Add view among them, and the settings page, both themes, both languages), the Add view, paste and import
specs, the View menu, the side panel, the list, the first run, password setup, entry and the user's own password, reset, shares, the security
record, the short settings, plugins, themes, presets, the guide, the cloud card, export, flows, the PIN after a restart,
Touch ID, `perf` and `perf-idle` (203 passed, 1 skipped: the View menu's screenshots, on request only). Ten mutants in
the unit tests (check-dist's three checks off, each move undone in the source, the settings `Icon` or the shared one
broken, `base.css` or `add.css` not imported) and two in Chromium (the Add view's grid lost; its stylesheet loaded
300 ms after its code, which draws a first frame unstyled): all killed, each file restored byte for byte.
