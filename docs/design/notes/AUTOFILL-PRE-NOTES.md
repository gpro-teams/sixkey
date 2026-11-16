# AUTOFILL-PRE notes: the hardening that must exist before any content script does

`docs/design/proposals/TOTP-AUTOFILL.md` §4.2 lists what has to be in place "before any code runs in a page", and §12.2
calls it the first step of the release train ("Pre: §4.2 hardening: sender checks in `sw.ts` and `offscreen/main.ts`,
storage access level, tests"). This package is that step and nothing else. There is no autofill feature in it: no content
script, no host permission, no `scripting` permission, no rules, no message from a page that the code did not already
have, and no new text. The manifest, the permissions and the catalogs are unchanged.

## 1. What changed

| Design item (§4.2)                                 | Where                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Sender checks, worker listener                  | `src/background/sw.ts`: both `onMessage` listeners start with `acceptedType(msg, sender, chrome.runtime.id, "worker")`                       |
| 1. Sender check, offscreen listener                | `src/offscreen/main.ts`: the listener starts with `acceptedType(..., "offscreen")`; before, it checked nothing                              |
| 2. `storage.local.setAccessLevel(TRUSTED_CONTEXTS)` | `src/platform/storage-access.ts` (the calls), `src/background/storage-access-first.ts` (made at load), first import of `sw.ts`              |
| 3. `storage.session` stays closed, with a test      | the same module sets it explicitly as well; `test/unit/autofill-pre-storage.test.ts` asserts it                                             |

### 1.1 The sender policy: `src/platform/sender-policy.ts`

One table, `MESSAGE_SENDERS`: for each message type, the receiver (`worker` or `offscreen`) and the list of surfaces that
may send it. A surface is one of the extension's own contexts, recognised by URL path: `popup`, `options`, `devsync`
(dev and e2e builds only), `offscreen`, `worker` (`/sw.js`).

| Type                     | Receiver  | Allowed senders                            | Sent from                                                    |
| ------------------------ | --------- | ------------------------------------------ | ------------------------------------------------------------ |
| `sk-reschedule-autolock` | worker    | popup, settings                            | `popup/App.tsx`, `options/App.tsx`, `options/PinBox.tsx`     |
| `sk-sync-soon`           | worker    | popup, settings, (developer page)          | `platform/runtime-base.ts`, after a commit with sync on      |
| `sk-sync-changed`        | worker    | settings, (developer page)                 | `options/sync/gateway.ts`, `devsync/main.ts`                 |
| `sk-clip-arm`            | worker    | popup, settings                            | `platform/clipboard.ts`                                      |
| `sk-api`                 | worker    | settings, (developer page)                 | `platform/bridge-page.ts` (the same pages as `BRIDGE_PAGES`) |
| `sk-offscreen-done`      | worker    | offscreen document                         | `offscreen/main.ts`                                          |
| `sk-offscreen-arm`       | offscreen | service worker                             | `background/sw.ts`                                           |

`acceptedType(msg, sender, selfId, receiver)` returns the type or `null`, and everything not `null` is ignored with no
answer, no work and no error. It accepts only if:

- the message is an object with an own string `type` that has a row (so `constructor`, `__proto__` and inherited values
  do not count) and the row's receiver is this receiver;
- `sender.id === selfId`;
- `sender.url` parses as `chrome-extension://<selfId>/<path>`: scheme, host exactly the ID (no port, no user info), and
  the pathname exactly equal to one surface's path (not `startsWith`, so `/popup/index.html.evil` and
  `/popup/index.html/x` fail). Query and fragment are ignored. A content script's `url` is the web page's;
- `sender.origin`, when the browser provides one, is `chrome-extension://<selfId>`;
- `sender.tab`, when there is one, has a URL of this extension. A tab with a web URL, or with no readable URL, fails.
  This is the design's "`sender.tab` is absent or the URL is one of our own pages";
- the surface is in the row's list. The developer sync page is a surface only when the build defines `__SYNC_DEV__`
  (the same define as `BRIDGE_PAGES`), and then it may send the three sync types and nothing else. In a production
  build the module does not mention it at all (`m5-build-guard` asserts the worker has no `devsync`); that is why the
  policy has no `dev` argument, and its tests import a fresh copy of the module with the define set.

The bridge keeps its own check as a second line (`isBridgePage`, `serveBridge`), unchanged.

One consequence is a small fix. A bridge message from a page that is not a bridge page used to make the second listener
return `true`, which keeps the sender's channel open with no answer for as long as the worker lives. It now returns
`undefined`, and the sender's promise resolves at once.

The modules are separate on purpose: the popup does not import the policy (the popup's budget), so the message types are
written out in it instead of imported from `runtime-base.ts`; a test compares them with the constants.

### 1.2 Typed handler table (a type cannot be added without a policy)

`sw.ts` dispatches through `HANDLERS`, typed `{ [K in Exclude<MessageFor<"worker">, "sk-api">]: ... }` over the policy's
rows. A row without a handler, and a handler without a row, both fail `npm run typecheck` (mutants T01 and T02). The
offscreen document handles one type. A message type whose handler is added any other way (a `.type ===` comparison in a
listener, a third listener, a port) is caught by `test/unit/autofill-pre-source-rules.test.ts` (§3).

### 1.3 The access level: `src/platform/storage-access.ts`

`restrictStorageAccess()` calls `setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` on `storage.local` and
`storage.session`. Reading of the design, where it was open:

- **When.** The design says "at the worker's top level". `sw.ts` imports `./storage-access-first` as its first import;
  that module's body runs first and starts both calls, before the runtime is built, before any listener is added and
  before any storage read. The calls are issued synchronously, side by side; a call that fails, throws or never settles
  does not delay the other or the worker, and nothing waits for the promise.
  **What this does and does not protect.** The order is the worker's own: it fixes when the worker asks the browser. A
  content script's `chrome.storage.local.get` goes from its renderer to the browser and never through the worker, so
  the worker's start order protects nothing against it. What protects it is the browser keeping the setting once
  it is made. On the very first install, until the browser has processed the call, local storage is as open as it is
  by default; today nothing can use that gap, and a future content script is registered only after the worker has run.
  Checked in a real browser by an independent review: Chromium 145 and 156 refuse a content script's reads and writes
  after the call, and keep refusing after a browser restart. Chrome 120 to 139 cannot close `storage.local` at all [verified
  in source: its `setAccessLevel` arrives with Chromium a8f1f337, M140], and Stage 1 injects nothing there
  (AUTOFILL1-NOTES §17, STORAGEGATE); 140 to 144 are not probed, nor is the case of an extension update or reload.
- **Every start, not only on install.** Whether the setting persists is the design's unverified probe P1, so the call is
  repeated at every worker start. It is idempotent.
- **`storage.session` is set explicitly.** It is closed by default [verified in the design]. The most conservative
  reading of "stays at its default, with a test that asserts it" is to also set it, so a default that changed or a stray
  write of the other level is undone at the next start, and to assert in tests that no code passes the other level.
- **A failure** (an old browser, the API missing, a rejection) does not stop the worker. It is written to the
  diagnostics log, which is what the user exports: **one line for both areas**, `storage access level not restricted:
  local, session` (or only one of them). Two lines written in one tick would race in `diag.ts`, which has no lock, and
  the second write would win, losing the `local` line that is the K2 signal. And the line is written **once** while it
  stays in the log (`createDiagOnce`): a browser that refuses the call would otherwise add a line at every worker start
  and push everything else out of the 50 entries. This is the observable half of probe P1 and kill criterion K2: if
  `local` cannot be closed, Stage 2 is cut, and Stage 1 injects nothing (STORAGEGATE: the gate asks again before every
  injection; it does not rely on this line).
- **`storage.sync` and `storage.managed`** are not touched. The extension never uses either (the design's table names
  them as exposed by default, but they hold nothing), so there is nothing in them to protect. Nothing tests that they stay unused.

### 1.4 Also in this package

- The offscreen document's delay: a `delayMs` that is not a finite number falls back to the 30 s default. Before,
  `"0"` (a string) went to `Math.max("0" ?? 30000, 1000)` and the clean-up could be fired at once. It is pure hardening
  of the message that the new sender check already limits to the worker. The worker passes `delayMs` through unchanged.
- **The bundle's order is checked on the built file.** `scripts/sw-order.mjs` runs the built `sw.js`'s top level once
  in a Node `vm` over a logging `chrome.*` stand-in (every asynchronous call never settles, so only the top-level code
  runs) and requires the first two calls to be the two `setAccessLevel` calls, once each, before any `addListener` and
  any storage access. `check-dist` runs it on prod, e2e and dev builds. Under vitest, modules run asynchronously and a
  deferred call can still come out first, so the unit tests show only that the module makes the calls and that the
  source has the right shape; the bundler's order is this check's. (Adapted from the independent review's probe.)
- **`sk-clip-arm` is answered.** The worker answers a request it took with `{ok: true}` (`{ok: false}` for a hash that
  is no string); a refused sender gets nothing. `armClipboardClear` returns true only on `{ok: true}`, so a sender the
  policy refuses (for instance a Chrome that shapes the settings page's `sender` differently) no longer makes the popup
  show a "clears in 30 s" countdown that nothing will honour. The answer says the request was taken; a later failure to
  create the offscreen document is still silent, as before. This touches `platform/clipboard.ts`, which the popup
  imports: the popup's gzip grows by about 7 B (five popup chunks, gzipped separately; store build 56.1 KB, and the gate-open figure moves from 58,301 B by the same few bytes, against 61,440 B).
- "No other way in" now also covers the worker's own `message` event, `BroadcastChannel`, `MessageChannel`,
  `postMessage`, `new Worker`, and `storage.onChanged` outside the pages that use it today.
- ARCHITECTURE §4 and `docs/security/local-vault.md` say what the worker and the offscreen document now check, and
  what the access level does and does not guarantee. TOTP-AUTOFILL §1.2 and §4.2 item 1 carry a note that the old
  state they describe is gone.
  `docs/PRIVACY.md` is unchanged: nothing about what the extension reads or sends changed, and it still has no content
  scripts.

## 2. Tests

All new. The expected table in `autofill-pre-sender.test.ts` is written out by hand and is not read from the policy, so
changing a row has to change the test as well.

- `test/unit/autofill-pre-sender.test.ts` (26 tests)
  - The policy on its own: each surface by exact path (query, fragment, upper-case scheme, in a tab of ours), and 37
    hostile senders (a content script with a web URL, origin and tab; a web URL that spells our path; our URL with a web
    tab, with no readable tab URL, or a web origin; another extension's ID or page; no ID, no URL, no sender; `about:`,
    `data:`, `blob:`, `filesystem:`, `chrome:`, `chrome-untrusted:`; a host with a suffix, upper case, a port, user
    info; paths with a suffix, a trailing slash, the wrong case, an encoded slash) that are no surface at all. Each field
    is also wrongened alone on an otherwise good sender.
  - The table: the same keys as the hand-written one, every (type, surface, receiver, dev) combination decided, prototype
    names and non-string types refused, and the bridge's page list equal to the pages that may send `sk-api`.
  - The real `sw.ts` over fake `chrome.*`: every worker type from each allowed surface (plain, and in a tab) has its
    effect exactly once (sync state read, offscreen document created and the arm message sent, `closeDocument` called, a
    fetch made); from every hostile sender and from every page the row does not name, no effect and no channel kept
    open, for every type; `sk-offscreen-arm` is ignored by the worker from every sender; unknown types are ignored; the
    gate runs before any storage read. In a dev build (`__SYNC_DEV__` stubbed true) the developer page sends exactly
    the three sync types; in a production build or with no define it sends nothing.
  - The real `offscreen/main.ts` with a fake document and fake timers: the worker's message arms, reads, clears if the
    clipboard still holds the code, and reports done; every hostile sender, every other page and every other type is
    ignored; a malformed arm does nothing and a non-numeric delay does not become zero.
- `test/unit/autofill-pre-storage.test.ts` (22 tests): the exact call and argument on both areas; both calls made
  before the function returns (neither waits for the other); failure per area (reject, throw, missing function, missing
  area); in `sw.ts`, the two calls are the first two entries of the call log, before any listener and any storage
  access, once per start; a failure, a throw, a missing API or a call that never settles leaves the worker running and
  writes ONE combined diagnostics line (both areas refused: one line naming both), once across repeated starts, with the
  other 48 lines of a nearly full log kept; source rules: only `storage-access.ts` calls `setAccessLevel`, the only level in the
  source is `TRUSTED_CONTEXTS`, `TRUSTED_AND_UNTRUSTED_CONTEXTS` is in no code, `storage-access-first` is the first
  import of `sw.ts` and imported by nothing else, and there are no `content_scripts`, no `scripting` permission and no
  injection call.
- `test/unit/autofill-pre-source-rules.test.ts` (9 tests): every `"sk-..."` string in the source is a row or a listed
  alarm name, and every row is used; every `runtime.sendMessage` call site is in a listed file and sends a row's type;
  `runtime.onMessage` has exactly 2 listeners in `sw.ts` and 1 in `offscreen/main.ts`; none of `onMessageExternal`,
  `onConnect`, `onConnectExternal`, `runtime.connect`, user-script messaging, `externally_connectable`; each listener's
  first act is the gate for its own receiver and the file reads `.type` nowhere else; the handler table's keys are the
  worker's rows; only `sw.ts` and `offscreen/main.ts` import the policy.
  **A new message type fails this file until it has a row, a handler and a sender entry**, and a new alarm name fails it
  until it is listed (`ALARM_NAMES`).
- Changed existing tests: `m5-source-rules` (the developer page's name may now also be in `sender-policy.ts`),
  `m5-sw-wiring` (a bridge message from the popup now keeps no channel open; before, the worker kept it open and never
  answered) and `enroll-v2` (its fake worker now answers `{ok: true}` to `sk-clip-arm`) and `quick-pin-races` (its guard "no `setAccessLevel` anywhere in `src`" now allows exactly
  `platform/storage-access.ts`, and requires every level in it to be `TRUSTED_CONTEXTS`; the intent, that nothing
  opens session storage to untrusted contexts, is kept and made stricter).
- `test/unit/autofill-pre-check-dist.test.ts` (12 tests): `scripts/sw-order.mjs` on small stand-in bundles (a listener or a read
  first, a deferred call, one call, three calls, no call, a throw). `m5-check-dist.test.ts` gains 9 cases: prod, e2e and
  dev builds altered (a listener before the calls, a read before them, the calls renamed away) must fail check-dist.
  `m5-build-guard.test.ts` now scans every script of the prod build for `devsync`, not only `sw.js`.
- The sender tests also cover `sk-clip-arm`'s answer (and `armClipboardClear` against the real worker: true only if taken).
- `test/helpers/sw-world.ts`: the worker over fake `chrome.*` with an ordered call log.

### Mutants

Run one at a time against the new test files and `enroll-v2`/`m5-sw-wiring`/`quick-pin-races`; the harnesses are not in
the tree (CONTRIBUTING rule 4: describe the mutants). The implementer's 49: **47 killed**. The two that survive, M20 and
M21, each remove one of two redundant guards against an empty own ID, so each is equivalent to the original alone;
removing both together (the reviewer's N40) is killed. The independent review's 27 (`tools/review-mutants.py` of the
review): **26 killed**, the survivor N38 being equivalent by the review's own analysis; its N08, N09 and N49
(ungated `message` event, `BroadcastChannel`, `storage.onChanged` in the worker) are killed by the extended source rules
since this round. The bundle-order check (`check-dist`) was also run against two hand mutants built for real: the
access-level call deferred by a timer (fails: the first calls are `addListener ...`), and, for control, only the
`sw.ts` import order swapped (passes, correctly: the worker's body always runs after its imports).

| Group                | Mutants (each killed)                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender fields (policy) | drop the `sender.id` check; accept any extension ID (only "id present"); drop the URL scheme check; drop the URL host check; drop the `origin` check (web origin accepted); drop the `tab` check (our URL with a web tab); a missing `tab.url` accepted; path by `startsWith`; the URL read from the wrong field (`tab.url`); user info in the host allowed; an empty own ID accepted (both guards) |
| Table                | `in` instead of own-property lookup (`constructor`); receiver not compared; allowed-surface list not compared (any own page); popup added to `sk-offscreen-done`; options added to `sk-offscreen-arm`; popup added to `sk-api`; the developer page added to `sk-clip-arm` or dropped from `sk-api` in a dev build; the developer page allowed in a production build (define ignored); the check skipped for one type only (`sk-clip-arm`) |
| Worker (`sw.ts`)     | first listener's gate bypassed; bridge listener's gate bypassed; the old check only (`sender.id === runtime.id`); `sk-clip-arm` handled before the gate; the worker listens as the offscreen receiver; the worker compares with the sender's own ID; a new `.type ===` branch with no table row |
| Offscreen            | gate dropped; the old check (ID only); gate fed the worker's URL; a delay that is a string used as given (`"0"`) |
| Access level         | the failure line written twice (the race), at every start (no dedupe), or not at all; `local` skipped; `session` skipped; wrong level passed; the call deferred behind the listeners (ordering); the two areas set one after the other; a failure not written to diagnostics; a failure thrown instead of returned; `storage-access-first` no longer the first import; the call made once per install instead of per start |
| Clipboard            | `sk-clip-arm` taken but not answered; a bad hash answered `ok`; `armClipboardClear` true whatever the reply |
| Type level           | a table row with no handler, and a handler with no row: both fail `npm run typecheck` (run as mutants with `tsc`) |


## 3. Left out, and why

- **The content-script channel and its own listener** (§4.3): it is the feature. When it comes it needs its own listener
  with a closed message set and its own rows; the exhaustiveness tests will fail until it has them.
- **The rate limit, and the page's identity from `sender.origin`, `sender.frameId` and `sender.documentId`** (§4.3): the
  channel's.
- **Probe P1 on Chrome 120 to 144** (does `local.setAccessLevel` work, does it persist before the worker runs, and can a
  renderer that hosted an injection keep using the APIs): it needs a content script to be written. The independent review ran a
  throw-away content script in Chromium 145 and 156 (reads and writes refused after the call, still refused after a
  restart; update and reload not covered). Chrome 120 to 139: `local` cannot be closed [verified in source], and Stage 1
  injects nothing there (AUTOFILL1-NOTES §17); 140 to 144 are not probed. The diagnostics line is how a real browser's
  refusal shows up.
- **The §12.4 changes** (`check-dist.mjs` permission and CSP lists, `PRIVACY.md` wording, new budgets): they belong to
  the feature, because they are about what the feature adds.
- **`storage.sync` and `storage.managed`**: unused (§1.3).
- **A check on `sender.frameId` / `documentLifecycle`**: our pages cannot be embedded in a web page (no
  `web_accessible_resources`, which `check-dist` enforces), so a frame check would be a second line with nothing behind it.
- **Reading the access level back**: Chrome has no getter. The tests can only check what was asked.

## 4. Open points

- **Two browser facts the policy relies on** were unverified when it was written: that Chrome reports the worker's own
  messages as coming from `/sw.js`, and that it fills `sender.tab.url` for the settings page open in a tab without the
  `tabs` permission. §5 shows the end-to-end tests that need both pass in Chromium. If a Chrome version differs, the
  clipboard clean-up and the settings page's messages stop working (their e2e tests fail, and the popup no longer shows
  a clean-up countdown that nothing will honour), not silently open.
- A message type added later needs: a row in `MESSAGE_SENDERS`, an entry in the hand-written table of
  `autofill-pre-sender.test.ts`, a handler (the compiler asks for it), and, if it is sent from a new file, a line in
  `autofill-pre-source-rules.test.ts`.

## 5. Verification

All in a private copy of the tree (`nice -n 19`, vitest `--maxWorkers=2`). Round 2 (after the independent review) is built
on the live tree with the budget changes merged.

| Check                                  | Result                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                    | clean                                                                                                                      |
| `python3 scripts/messages.py`          | no change to `_locales/` or `catalogs/` (no new text)                                                                      |
| `npm test` (vitest, one full run)      | 188 files, 2651 passed, 4 expected fail, 1 skipped (the new files: 4, with 69 tests)                                       |
| `npm run build`, `npm run check`       | prod, e2e and dev builds pass, including the new bundle-order rule; `dist/sw.js` has no `devsync`; popup 56.1 KB of 60 KB (prod), 57.0 KB (e2e), a few bytes more than without this change |
| `npm run format:check`                 | clean                                                                                                                      |
| `npm run e2e` (Chromium), 38 tests     | all passed, in a scratch copy with the API port changed: `flows`, `quick-pin`, `smoke` and every `regression` spec (the clipboard, offscreen-race, page-csp and permission specs among them). The rest of the e2e suite was run once in round 1 on the same sender and storage code (124 of 131 passed there; the failures were a timing test that passed alone and `test/sync/*` specs that need the API server). |

**End to end (Chromium).** The clipboard tests of `flows.spec.ts` (page asks the worker, worker creates the offscreen
document and arms it, the document clears the clipboard and reports done; the popup's countdown now waits for the
worker's `{ok: true}`), `offscreen-race.spec.ts` and `page-csp.spec.ts` pass. So Chrome reports the worker's own messages
as coming from `/sw.js` and fills `sender.tab.url` for the settings page open in a tab, without the `tabs` permission.
The independent review confirmed the same with a content script injected into a web page (Chromium 145 and 156): every
type is refused, the replies are all `undefined`, and the access level refuses its reads and writes and survives a restart.
`npm run e2e:sync` was not run (it needs the API server).

## 6. After the review (round 2)

An independent review (verdict: merge after fixes, no blocker) led to these changes; none changes what is let through.

- MINOR-1: the bundle's order is checked on the built file (`scripts/sw-order.mjs` in `check-dist`; §1.4). The notes no
  longer present the vitest call-log test as the ordering check.
- MINOR-2 and 3: one combined diagnostics line, written once while it stays in the log (§1.3).
- MINOR-4: the claims about what the access level guarantees are corrected in `docs/security/local-vault.md`, ARCHITECTURE
  §4, §1.3 here and TOTP-AUTOFILL §1.2 / §4.2 (the old state they describe is gone).
- MINOR-5: the "no other way in" rule covers more (§1.4).
- MINOR-6: `sk-clip-arm` is answered, and `armClipboardClear` reports only a request the worker took (§1.4).
- NITs: three more hostile senders (empty origin, an origin that only starts like ours, an empty tab URL); the prod
  build guard scans every script for `devsync`; the "both empty-ID guards" mutant is the reviewer's N40 (the earlier
  harness entry for it, M23, removed only one guard and was mislabelled); the unit tests parse URLs with Node's parser,
  which treats `chrome-extension:` as a non-special scheme, so "host in upper case" and "host with a port" are refused in
  the tests but Chrome's own parser would normalise both to our origin; Chrome's `sender.url` is canonical, so this
  changes nothing in use. The popup opened from the toolbar (not in a tab) was never exercised in a real browser: the
  policy accepts it with or without a `tab`, and that is an open point.
