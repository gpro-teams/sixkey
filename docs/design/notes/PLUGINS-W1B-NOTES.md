# Plugin platform, wave 1b: autofill as the built-in official plugin

Wave 1b carries out MOD-PLATFORM §7.2 Option I (OWNER-DECISIONS/16, Q-A (a)). It also folds in Chrome 140 as the
minimum (OWNER-DECISIONS/14, OQ1 (a)) and three follow-ups from wave 1a. The platform itself is wave 1a's
(`PLUGINS-W1A-NOTES.md`). The normative text is the SDK spec (`docs/sdk/SIXKEY-PLUGIN-SDK.md` §8.2, §8.5).

## 1. What the user sees

- **Settings › Plugins.** The first row is always _Autofill · Official · Built in_, with an On/Off switch and one line
  on what Off does. Under it are the platform's _Recent requests_ for autofill, one `codes.forPage` line per fill with
  its outcome. The row is not a plugin of someone else's: with no other plugin, the page still says _No plugins yet._
- **Settings › Security › Autofill.** This is the plugin's page. The same switch is at the top, above the list of sites
  as before. While autofill is off, no site offers _Turn on again_, because the switch is how to turn it on.
- **A fresh install holds no `scripting`.** The popup and the side panel show the account's _Fill code_ button but not
  the strip above the list, because there is nothing yet to look at the page with. The first click asks Chrome for
  `scripting` in the click itself. It has no warning, so Chrome grants it without a dialog, and the click fills. From
  then on the strip appears as before.
- **The shortcut without `scripting`** opens Sixkey at the Fill button, focused, and fills nothing. A keyboard
  shortcut's gesture cannot carry a request, so the click on that button asks and fills.
- **Off.** The content script is unregistered, then each listed site's own grant and `scripting` are given back, all by
  the worker (r2: §10). The list of sites and the vault are kept; the sites' rows show no status while autofill is off. A
  Fill click then says _Autofill is off. Turn it on in Settings › Plugins._, asks Chrome for nothing and does not look at
  the page; the shortcut opens Sixkey at that button.
- **On** makes one request: `scripting` and the listed sites' patterns. Chrome shows at most one dialog, and none for
  sites it remembers. The sites come back.

## 2. The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| The built-in | `src/core/plugins/builtin.ts` | Reserved ID `"a" × 32`, the catalog row (official, ceiling `codes.forPage`), the switch as a grant-store entry: none is On, `disabled` (reason `user`) is Off, `approved` with `granted: ["codes.forPage"]` is On again. Pure. |
| The runtime catalog | `src/platform/plugins/chrome.ts` `catalog()` | Appends the built-ins and drops any file row with a built-in's ID. |
| The switch's write | `GrantStore.setAutofill` | One tagged write of autofill's entry alone, which needs the vault key. |
| The gate | `src/platform/plugins/autofill-gate.ts` | `autofillAllowed`: the vault key, then the switch's record (`switchRecord`: the verified one, or where its tag fails the record read tighten-only, as the worker reads it: r2, OD-1), the switch, the trust level and what the entry holds within the ceiling. `gatedCode` logs each ask in the platform's request log under autofill's ID (`ok`, `locked` or `disabled`), and only then works out the code. It answers `{code}` or `{no: "off" \| "locked"}`. |
| The fill | `src/platform/autofill.ts` `fillCand` | It has no code of its own. `d.code` is required (no default) and is the gate's. The answer is asked after the wait, the cancel check and the vault's re-read. A refusal fills nothing. |
| Who passes the gate | `popup/main/Fill.tsx`, `background/sw.ts` | The popup and side panel use their service's `grantKeys` (Main connects it when it loads the Fill chunk). The shortcut uses the worker's. |
| The switch's UI | `src/options/AutofillSwitch.tsx` | A module of the platform's, in Plugins' row and lazily in the autofill page. Shown only while unlocked, since its write is tagged. |
| On and Off | `src/platform/plugins/autofill-switch.ts` | Off (the page) writes the switch and sets the hint, nothing else. On is `askAutofillOn` (one request, the click's first statement) and then `turnAutofillOn` (the hint cleared, then the switch written). `giveBackSites` is the worker's: each listed site's exact grant (`grantedExactly`, one call each). |
| The worker follows the switch | `src/platform/autofill-reconcile.ts` `followSwitch`, `sw.ts` | A write of `sk_plugins` (`watchSwitch`) starts a reconcile, and nothing else does (r3: no timer). If autofill is off and that run unregistered, each listed site's grant is given back, the switch read again before each, then the switch is read again and `scripting` is given back. Never at a worker start or on a grant. A Fill click that got `scripting` from Chrome and then met the gate's "off" writes the record again unchanged (`touchSwitch`), which is followed like any switch write. |
| Reconcile | `reconcileOnce`, `workerReconciler` | It asks the access gate first, then `usable`. When `usable` is `unscripted` (no `scripting`), no registration call is made. When it is `off`, it applies none. It runs again on every permission event that names `scripting`. |
| The page hint | `sk_af_off`, page `localStorage` (`platform/autofill-sites.ts` `offHint`/`setOffHint`) | **New in this wave** (see §4, B). It tells a Fill click that autofill is off without a chrome.storage read at open, and only ever decides not to ask Chrome. The gate is what decides. |
| Chrome 140 | `manifest.base.json` `minimum_chrome_version: "140"`; check-dist requires `>= 140` | STORAGEGATE stays as the second layer. |

`scripting` is guarded everywhere. `scriptingHeld()` is `permissions.contains({permissions: ["scripting"]})`, not the
namespace, because probe 1 found the namespace stays defined after `remove()`. Callers:

- `scan()` returns `ask` without it;
- `fillCand()` checks it before its `executeScript`;
- the registration calls read `globalThis.chrome?.scripting` when they are made, and an apply without it does nothing;
- the shortcut's `fillOnTab` returns `ask`, which opens Sixkey (`NEEDS_SURFACE`);
- the popup's `resumeFill` stops at the button.

Every click that may need `scripting` asks for it as its first statement, before anything is awaited:

- `press()` calls `askScripting()`, which is skipped when the hint says off or `scripting` is held;
- `requestSite()` asks for `{permissions: ["scripting"], origins: [pattern]}`;
- the switch's `flip()` calls `askAutofillOn(hosts)`, with the hosts read when the page drew.

## 3. Probes (Chromium under Playwright, the e2e build with `scripting` optional)

1. **The request.** Before the grant `chrome.scripting` is undefined in the popup and the worker. Without a gesture,
   `request` rejects. With one, it resolves `true` in about 100 ms with no dialog, and the namespace appears in both
   without a reload. `executeScript` then works through `activeTab`. After `permissions.remove`, the namespace **stays**
   defined. `scripting` asked with an origin the build grants resolves without a dialog, and with an undeclared origin
   it rejects.
2. **The upgrade, with the real base build: what Chrome keeps.** The base build held `scripting` as required, with a
   site listed and registered. The browser was closed, the files replaced by the new build's, and the browser started
   again on the same profile, folder and ID. Afterwards `scripting` is still held (now as the optional one), the
   registration `sk-suggest` is kept, and `sk_af_sites` and every vault key are kept. **Corrected in r2 (the review's
   F-01):** that is the state Chrome kept, not the new worker's behaviour. The reviewer's probe P1 showed that after such
   a restart Chromium 156, with `--load-extension`, keeps running the OLD worker (its hook is the base bundle's; the
   platform log stays empty; Off in the new Settings does not stop the shortcut). This probe did not check which worker
   ran, so it most likely saw the old one too. A `chrome.runtime.reload()` after swapping the files left no worker under
   Playwright (the reviewer: Chromium disables a `--load-extension`'d copy on a reload), so the reload path is not
   testable here: OWNER-CHECKLIST item 41 now updates with the reload button and checks for the new worker's log line.
3. **A registration after `scripting` is given back.** All three registration calls throw _not available in this
   context_, and **the registered script still runs** on a granted host (a new tab gets the finder). After a regrant the
   registration is still there. So Off cannot give `scripting` back first. Only the worker may make the registration
   calls (check-dist), so the worker unregisters, and only after a run that did so does it give `scripting` back.

## 4. The brief's hard requirements

**A. Budgets were measured first.** The text came first (`scripts/i18n/w1b.py`): four plugin-catalog keys, two Fill keys
and one worker key. Nothing had to be split and no limit changed. What the check counts as "loaded together" did not
change. The autofill page now also loads the plugins catalog, for the switch, and that catalog was already in the
page+every-lazy sum.

| What (gzip bytes, check-dist) | Base (live 710a451) | W1b | Limit / allowance |
| --- | --- | --- | --- |
| Popup, gate open | 59,158 | 59,237 (+79) | +400 against 59,151 (≤ 59,551); floor 1,500 headroom of 61,440 (2,203 left) |
| Popup, gate closed (today's store build) | 57,902 | 57,982 (+80) | 61,440 |
| Side panel, gate open | 61,385 | 61,465 (+80) | 63,488 |
| Side panel, gate closed | 60,129 | 60,212 (+83) | 63,488 |
| Settings, every part (zh_CN) | 12,123 | 12,123 (0) | 12,288 |
| A vault's page with every lazy catalog (zh_CN) | 14,979 | 15,048 (+69) | 15,360 (312 left) |
| Plugins catalog (zh_CN) | 1,612 | 1,730 (+118) | 3,072 |
| Fill catalog (zh_CN) | 1,498 | 1,542 (+44) | 4,096 |

The popup and the side panel grow by about 80 B each: Main's one line connecting the gate's key, and the guards in the
modules they share with the Fill chunk. This was measured as a total and not broken down further. The gate, the switch
and their text are in lazy chunks.

**B. No new chrome.storage read at popup open.** The popup's open is unchanged: perf.spec's six reads still pass. Every
new check is made in a click, or by Chrome:

- "Is `scripting` held" is `permissions.contains`, at the look (`scanPage`) and in a click.
- "Is autofill on" in a click is the page hint `sk_af_off`. **Flag: this is a new hint, not an existing one.** It lives
  in page `localStorage`, like `sk_plugins_any`.
- The hint never says "off" while the switch is on, except in the window of a cut-short On. Off sets it after the write
  and On clears it before the write, so a cut short in between leaves it saying "on" while the switch is off. The next
  Fill then meets the gate, which says "off" and sets the hint again.
- Every verified read that draws the switch also sets it from the record: Settings' `keepHint` in
  `ui/plugins/view.ts`, and the switch's own load.
- Locked, the hint is left as it is. With a record that fails its tag, the switch's own load sets it from the
  tighten-only reading (r2).

**C. User activation.** No await comes before any of the three requests (source rules in
`plugins-w1b-source-rules.test.ts`). The e2e shows each grant succeeding after a lazy chunk loaded:

- the first Fill click, after the Fill chunk and its catalog loaded, in the popup and in the side panel
  (`plugins-w1b.spec.ts`, the fresh-install and site-first tests);
- the shortcut's surface (the same spec);
- On from Settings › Plugins' row, after the platform's chunk loaded. Its one request, `scripting` plus the listed
  site, is recorded.

**D. The upgrade.**

- **e2e:** `plugins-w1b.spec.ts` "the upgrade" runs the e2e build with its manifest rewritten to the old shape:
  `scripting` required, not optional, Chrome 120. It turns a site on (registered), closes the browser, puts the new
  manifest in place and starts the same profile again. Then it checks that the ID is the same, `scripting` is held,
  the registration and `sk_af_sites` are unchanged, the vault's records are byte-for-byte the same, and the unlock shows
  the account. On the site the content script runs, a trusted click sets the badge "1", and the shortcut fills.
- **The limit, stated:** this is the new code in the old manifest's shape, not the old code: it shows what Chrome keeps
  across the change of the manifest (the grant, the registration, the data). Probe 2 shows the same with the real base
  build, but not that the new worker runs afterwards: after a plain restart it did not (r2, F-01). No automated test here
  can show an unpacked update reaching the new worker.
- **Real Chrome:** OWNER-CHECKLIST item 41: update with the reload button ↻ (a restart alone is not enough), check that
  the shortcut's fill adds a `codes.forPage ok` line to Settings › Plugins' recent requests (only the new worker writes
  it), and that with autofill off the shortcut does not fill. A store update was not verified either way.
- **Not added: a build-ID guard** (the page asking the worker for its build and telling the user to reload). It needs a
  new message type in the sender policy and a new string next to a near-full settings budget, and its one trigger cannot
  be reproduced here; the checklist step covers the owner's own unpacked updates.
- If Chrome ever dropped the grant on an update, nothing is lost. The next Fill click or On asks again, and the
  worker's reconcile registers once `scripting` is back.

**E. Never lose data.** Off, On and the upgrade write only autofill's entry in `sk_plugins` and the hint. The e2e
compares the vault's records and `sk_af_sites` before and after each:

- Off gives back grants but never edits the list (`writeList` and `removeSite` are not called: a source rule);
- the vault is never touched;
- a record that fails its tag is kept, as wave 1a keeps it.

## 5. Wave 1a's follow-ups

- **An add-by-ID plugin never asks for `management`.** In the e2e the test answer is "refused": had Sixkey asked,
  turning the plugin on would fail with _Not turned on: without permission…_. The plugin is approved, turned off and
  turned on again, and that line never appears.
- **When `management` is given back.** SDK §8.2 already said "when no listed plugin that is not turned off is left",
  but the code gave it back only on Remove. Now Off gives it back too: `(what === "remove" || what === "off") &&
  !stillNeeded(view, id)`. Turning a listed plugin on again asks again.
  - e2e: the listed plugin is approved, Chrome's `contains` is stood in as held (the e2e build's answer does not make
    Chrome grant it), and Off gives back `{permissions: ["management"]}`.
  - Real Chrome: checklist item 42.
- **`GrantStore.suspend` and `suspended()` are removed.** Only tests used them. The tests now suspend through
  `tightened`, and the crash test's operation is now "turn the built-in autofill off" (`setAutofill`).

## 6. Tests

- **Unit, new.**
  - `plugins-w1b-gate.test.ts` covers:
    - the ID and catalog row, and a file row claiming the ID being dropped;
    - the switch's writes, which change nothing else;
    - the gate (locked, on by default, off, on again, a failed tag) and its log entries, which hold no code, secret or
      account;
    - the held capability within the ceiling: a grant without `codes.forPage`, an overlay `disable`, a catalog row
      with no ceiling or a `listed` level;
    - Off: only exact grants are given back, a broad grant stays, the list is untouched, and the page has no
      `scripting` call;
    - Off while locked;
    - On: one synchronous request, then the hint, then the write; On refused or locked;
    - the hint healed by Settings' verified read;
    - `watchSwitch`;
    - `followSwitch`'s outcomes and its On-click sequence (the grant, the worker's start and permission runs, then the
      write never lose `scripting`);
    - reconcile's order (the gate first) and `usable`.
  - `plugins-w1b-source-rules.test.ts` covers the boundary, `scripting`'s guards and first-statement requests, the
    shortcut, the worker's events, and Off's split between the page and the worker.
  - The hint's writers.
- **Unit, changed.**
  - The autofill rules: `scripting` is optional and the registration's namespace is read at call time.
  - `fillCand`'s code comes from the gate.
  - Reconcile is wired as `workerReconciler(storageAccess, note, switchedOff)`, with `followSwitch` on the switch's
    write and a plain reconcile at start.
  - The listener list gains the switch's watch, and the plugins rules gain the one exempt import (`Fill.tsx` → the gate,
    with `Fill` reached by `import()` only) and the Off give-back.
  - The check-dist cases: `scripting` must be optional, may not be required again, and Chrome 139 or no minimum fails.
  - The tests' code stub is `test/helpers/gate.ts`, the open gate.
- **e2e, new.** `plugins-w1b.spec.ts` has seven tests:
  - the fresh install, in the popup;
  - the fresh install, in the side panel (the request from the panel's own click);
  - a site listed before the first Fill;
  - the shortcut without `scripting`;
  - Off and On, with the registration gone before `scripting` and a Fill refused as off;
  - the upgrade;
  - wave 1a's two follow-ups.
- **e2e, changed.**
  - `world()` grants `scripting` by a real click in an extension page, since nearly every autofill spec starts after a
    first Fill. `world({scripting: false})` is a fresh install.
  - `clickFill` clicks in a user gesture.
  - The visual guard grants `scripting` before it stubs the finder.
  - The manifest checks in `smoke` and `install-source` now expect `scripting` optional and not held, and Chrome 140 or
    later.
  - The site-on request now includes `scripting`.
- **Mutants:** see §8.

## 7. Deviations and decisions, with reasons

- **Off's order is the worker's.** The page gives nothing back (r2: not the sites' grants either). Probe 3 showed that a
  registration left behind keeps running where a grant remains, and that only the worker may unregister (check-dist).
  `followSwitch` runs on a write of the record only (r3): the switch's own, or the unchanged one a Fill click makes
  when it got `scripting` back while Off (`touchSwitch`). Never at a worker start or on a grant, because an On click's
  grant comes before its write, which may wait for the vault's lock as long as another page holds it. Residuals,
  stated:
  - An Off whose give-back never ran (the worker killed between the unregister and the remove) keeps `scripting` held
    until the next write of the record; the registration is gone and the gate refuses every code, and with the page
    hint set the popup does not look at pages.
  - Two surfaces at once: an On click in one, a Fill click's unchanged write in another landing between the On's grant
    and its write, can lose the On's grant. The next Fill click asks again, without a dialog.
  - A registration call that hangs past `APPLY_WAIT_MS` can be overtaken (the review's §2 note); its leftover would run
    only where a grant remains, which after Off is only an "On all sites" the user chose.
  - Settings' "Turn on again" while Off with the page hint missing (the hint normally hides it) would get `scripting`
    without the unchanged write; it stays held, harmlessly, until the next write of the record.
- **A record whose tag fails** (r2, the maintainers' decision on OD-1): the built-in's switch is read from the record
  unverified and tighten-only, Off if it says so, On otherwise, in the gate, in Settings and in the worker alike, and the
  autofill page shows the line that the approvals could not be checked (`pxBadTag`, an existing string). A flip writes a
  new, tagged record. No security cost: nothing in a record can give the built-in more than its ceiling, and a writer
  of Sixkey's storage could already turn it on by deleting the record (SDK §8.5).
- **The gate's answer carries the reason.** "Locked during the wait" shows its own line (`afLockedNow`) in the popup and
  the side panel, and the shortcut reports `locked`.
- **The worker drops a message from a built-in's ID.** No extension can have it, so this is belt and braces.
- **Turn on again is hidden while autofill is off.** The switch turns the sites back on in one request.
- **The "Autofill needs Chrome 140 or later" lines stay.** They now appear only where a browser still refuses to close
  storage (the second layer).
- **A refused or missing `scripting` has its own line** (r2, F-12: _Chrome did not let Sixkey into this page. Click
  Fill code again._), in the Fill catalog (lazy, far from its limit); r1 reused the "cannot look at this kind of page"
  line, which misled.
- **Docs.** The current-state documents now say Chrome 140: ARCHITECTURE, the SDK, local-vault, PRIVACY and the
  checklist. Design notes and proposals that describe Chrome 120 to 139 are left as written, because they record their
  own time. `OWNER-DECISIONS/` is not touched.
- **The built-in's entry in a kept-aside record** (after a failed tag) is not listed for review, and does not make the
  popup load the platform's chunk.

## 8. Measured at the end of r1 (r2: §10.1)

- **Gates:**
  - `messages.py`;
  - `typecheck`;
  - the prod, e2e and dev builds, each with check-dist OK, in a copy with the API port moved off 8787;
  - the gate-open store build, check-dist OK;
  - `format:check`, clean (formatted only through `npm run format`).
- **Unit:** the full suite under the heavy lock, 260 files: 3,921 passed, 4 expected fail, 1 skipped, 0 failed.
- **e2e:** the full suite in a copy with the API port moved off 8787, 389 passed, 0 failed. The side panel's fresh-install test was added after that run, and the W1b spec was run
  again on its own: 7 of 7 passed. `e2e:sync`: 12 passed. 127.0.0.1:8787
  was never touched.
- **Mutants (`scratchpad/w1b/w1b-mutants.py`, outside the repository): 24, all killed by assertions.** Each was applied to a fresh copy:
  1. the popup works the code out itself (the boundary rule);
  2. the gate skips the switch;
  3. a record that fails its tag counts. This was rewritten: its first form crashed into the gate's catch, an
     equivalent;
  4. nothing is logged;
  5. the ceiling is skipped;
  6. the look runs without Chrome's answer;
  7. the fill runs without it;
  8. "held" is decided by the namespace;
  9. switched off still registers;
  10. the first Fill's request comes after an await;
  11. Off gives `scripting` back before the run;
  12. the switch is not read again before the give-back;
  13. the page gives `scripting` back itself;
  14. the worker follows the switch at its start;
  15. `management` is given back on Remove only;
  16. a site's request leaves out `scripting`;
  17. On writes the switch before clearing the hint;
  18. check-dist allows Chrome 120;
  19. the worker answers the reserved ID;
  20. a catalog file claims the reserved ID;
  21. the built-in counts for the popup's hint;
  22. the shortcut runs without Chrome's answer;
  23. the resumed fill does not stop at the button;
  24. Off gives back a broad grant too.

## 9. For the owner

- Real-Chrome checks, OWNER-CHECKLIST items 39 to 42:
  - Off giving back optional site grants (the e2e build's are required, so they cannot be given back there);
  - the upgrade on a real install;
  - `management` given back on Off.
- Decided (r2): a record that fails its tag leaves the built-in autofill as it says, tighten-only (§7).
- Whether to add the build-ID guard for unpacked updates (§4 D; not added).
- The wording, drafts to approve with the store copy: _Built in_; the Off line; _Autofill is off. Turn it on in Settings ›
  Plugins._ (`afOffNow`); _Not filled: Sixkey locked while it waited for the new code._ (`afLockedNow`); _Chrome did not
  let Sixkey into this page. Click Fill code again._ (`afAskNo`); the shortcut's tooltip _Sixkey: open it and click Fill
  code_ (`fillTitleAsk`); what a site's row shows while autofill is off (nothing).

## 10. r2: the review's fixes (`REVIEW.md`, 修改后通过)

- **F-01, the upgrade's evidence.** A restart after replacing an unpacked copy's files kept the old worker (the reviewer's
  P1, Chromium 156 with `--load-extension`). §3 probe 2 and §4 D now say what that evidence shows (what Chrome keeps) and
  what it does not (that the new worker runs). Checklist item 41 updates with the reload button ↻ and checks the new
  worker by its `codes.forPage ok` line, then that the shortcut does not fill with autofill off. No build-ID guard (§4 D).
- **F-02 with OD-1, a record whose tag fails.** The built-in's switch is read from it tighten-only, the same in the gate,
  Settings and the worker (`switchRecord`, `switchedOff`), with the line that the approvals could not be checked on the
  autofill page. e2e: On in a spoiled record stays On everywhere (registered, `scripting` held, the content script runs,
  a Fill fills); Off in one stays Off everywhere. The reviewer's P2 (which asserted the split) now fails at its first
  assertion: the switch is checked.
- **F-03, the boundary.** An import-graph walk from every autofill module (`inject/*`, `platform/autofill*.ts`, the
  content channel, the fill request, the shortcut, Fill, the autofill page) must reach no code maker (`core/totp/hotp.ts`,
  `ui/otp.ts`, `ui/hooks.ts`) except through the gate. So autofill's time helpers moved to code-free modules
  (`ui/otp-time.ts`, `core/totp/time.ts`; the old names are re-exported). The e2e asserts the log's one `codes.forPage`
  line before acting on it, in the popup, the side panel and both shortcut paths.
- **F-04.** The shortcut checks locked first; the switch and `scripting` right before the look. Locked without
  `scripting`, the unlock is asked for, and after it the Fill button is focused (e2e).
- **F-05, F-06.** The SDK (§4.2, §6.6) and the comments say what the worker does with the session's key now. PRIVACY and
  local-vault say that `management` goes back on Off too, that Off gives back the sites' grants, what the switch does,
  and that every fill writes one `sk_plugin_log` line; the keys list gains `sk_plugins` and `sk_plugin_log`.
- **F-07, `scripting` regained while Off.** The popup does not look at the page while the hint says Off; the shortcut
  does not look while the switch is off (a worker read); a grant of `scripting` regained while Off is given back (e2e).
  r2 did that with a follow 5 s after the grant; r3 replaced it (§11, N-02).
- **F-08.** The sites' grants are given back by the worker, after the unregister (`giveBackSites`), so a page closed
  right after its Off leaves nothing behind; the page writes only the switch and the hint. While autofill is off the
  sites' rows show no status.
- **F-09.** The resume after an unlock keeps Chrome's answer and never asks without a click (`askScripting(gesture)`).
- **F-10.** Any state but `approved` is Off, `suspended` included (R06 now killed); an overlay `remove` disables the
  built-in instead of deleting its entry; SDK §8.5 says what "no entry is on" cannot hold (a record taken away whole).
- **F-11.** A unit test makes the unregister answer late: `scripting` goes only after it (R13 now killed).
- **F-12.** `remove()`'s comment back in place; the built-in's descriptor made when first needed (nothing at load can
  throw in the worker); the worker world's `contains` answers per permission; the autofill page's "off" follows the
  switch's own load; R22 now killed by a unit test (and the shortcut while Off opens Sixkey, e2e); a request spy in the
  `management` e2e; a refused or missing `scripting` has its own line (`afAskNo`, Fill catalog).

### 10.1 Measured (r2, the delivered tree)

| What (gzip bytes, check-dist) | Base | r1 | r2 | Limit / allowance |
| --- | --- | --- | --- | --- |
| Popup, gate open | 59,158 | 59,237 | 59,258 (+100) | ≤ 59,551; 2,182 left of 61,440 (floor 1,500) |
| Popup, gate closed | 57,902 | 57,982 | 57,996 | 61,440 |
| Side panel, gate open | 61,385 | 61,465 | 61,487 | 63,488 |
| Settings, every part (zh_CN) | 12,123 | 12,123 | 12,123 | 12,288 |
| A vault's page with every lazy catalog (zh_CN) | 14,979 | 15,048 | 15,048 | 15,360 (312 left) |
| Fill catalog (zh_CN) | 1,498 | 1,542 | 1,579 | 4,096 |

- Gates: `messages.py`, typecheck, the prod, e2e and dev builds with check-dist, the gate-open store build with
  check-dist, `format:check`.
- Unit, full, under the heavy lock: 260 files, 3,929 passed, 4 expected fail, 1 skipped, 0 failed.
- e2e, full, in a copy with the API port moved off 8787 and no `/e2e/` in its path (so `test/sync` is not collected,
  which r1's count of 389 had included): 381 passed, 1 skipped (quickview's screenshots, `SK_SHOTS`), 0 failed.
  `e2e:sync`: 12 passed. The W1b spec has 10 tests.
- The reviewer's probe P2 run against r2 fails at its first assertion: the switch is On.
- Mutants (`scratchpad/w1b/w1b-mutants-r2.py`): 36, all killed by assertions, the review's R01,
  R06, R13 and R22 among them.

## 11. r3: the r2 delta review's fixes (`REVIEW-r2.md`, 修改后通过)

- **N-01.** A write that starts from an empty record because the old one failed its tag now carries the built-in's Off
  over (`GrantStore.write`: the failed record read tighten-only, as the worker reads it; not `approved` gives a
  `disabled` entry in the new record). Approving another plugin again no longer turns autofill back on; a flip On still
  wins. The reviewer's Q1 is a unit test now.
- **N-02.** The 5 s timer is gone. Where a Fill click got `scripting` from Chrome (`askScripting` answered "granted")
  and then met the gate's "off", it writes the record again unchanged (`touchSwitch`: `grantStore().write(keys, (b) =>
  b)`), and the worker follows that write like the switch's own: the switch as it is when the write lands, no clock. An
  On whose write waits 9 s for the vault's lock keeps its grant (the reviewer's P6, now in the W1b spec). Why this is
  right, and its one gap: `scripting` can come back while Off only through a click in Sixkey (a Fill click, or "Turn on
  again", which the hint hides while Off); the Fill click is the one that meets the gate, so it is the one that writes.
  Two surfaces acting at the same moment remain the residual (§7).
- **N-03, the import-graph rule.** It now follows template-literal dynamic imports without substitutions, refuses a
  computed one, and reads a `.js`/`.jsx`/`.mjs` specifier as `.ts`/`.tsx` (G4, G5b). The gate module's exports are
  pinned by the TypeScript AST to `Allowed`, `autofillAllowed`, `gatedCode` and `touchSwitch` (G6). On the fill path
  (every autofill module but the Settings page, which fills nothing and reaches the vault's service as every settings page
  does), no module may use WebCrypto's `subtle`, `importKey`, `.sign(` or the string "HMAC" (G7); the grant store's own
  MAC (`core/plugins/grants.ts`) is reached from the fill path only through the gate, which the rule asserts. The list
  of hand-written autofill modules is asserted (G8), and r1's textual rule is back beside the graph.
- **N-04.** `giveBackSites` reads the switch again before each site: an On clicked while the worker gives sites back
  keeps every site not yet given back (the reviewer's Q2, by construction, is a unit test now).
- **N-05.** A DOM unit test for the switch's "could not check" line (D2); SDK §8.5 says the built-in no longer guards
  against an in-session rollback; the store-copy wording list (§9) includes `afAskNo` and the other new lines.

### 11.1 Measured (r3, the delivered tree)

| What (gzip bytes, check-dist) | Base | r2 | r3 | Limit / allowance |
| --- | --- | --- | --- | --- |
| Popup, gate open | 59,158 | 59,258 | 59,262 (+104) | ≤ 59,551; 2,178 left of 61,440 (floor 1,500) |
| Popup, gate closed | 57,902 | 57,996 | 58,000 | 61,440 |
| Side panel, gate open | 61,385 | 61,487 | 61,491 | 63,488 |
| Settings, every part (zh_CN) | 12,123 | 12,123 | 12,123 | 12,288 |
| A vault's page with every lazy catalog (zh_CN) | 14,979 | 15,048 | 15,048 | 15,360 (312 left) |
| Fill catalog (zh_CN) | 1,498 | 1,579 | 1,579 | 4,096 |

- Gates: `messages.py`, typecheck, the prod, e2e and dev builds with check-dist, the gate-open store build with
  check-dist, `format:check`. No new text in r3.
- Unit, full, under the heavy lock: 261 files, 3,939 passed, 4 expected fail, 1 skipped, 0 failed.
- e2e, full, in a copy with the API port moved off 8787 and no `/e2e/` in its path: 382 passed, 1 skipped, 0 failed (the
  W1b spec has 11 tests, the reviewer's P6 among them). `e2e:sync`: 12 passed. The reviewer's own P6 probe on r3: the
  write lands after 8.9 s, `scripting` is held at the end and the site is registered.
- Mutants (`scratchpad/w1b/w1b-mutants-r3.py`): 46, all killed by assertions: mine, the r1
  review's R01, R06, R13, R22, and the r2 review's G4, G5b, G6, G7, G8, D2 and T1's equivalent (T1 itself no longer
  applies: there is no timer; its equivalent, a follow at once on a grant, is killed by the source rules). Q1 and Q2 are
  unit tests.
