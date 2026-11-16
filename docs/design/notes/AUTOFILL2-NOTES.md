# AUTOFILL2 notes: TOTP autofill, Stage 2, patch 1 (a pending fill request, and the fill after an unlock)

> Patch 2 (per-site grants: the optional `https://*/*`, the Fill card's offer, Settings › Security › Autofill, reconcile,
> and the sync permission fixes) is §7 below.

Inputs: `AUTOFILL2-PLAN.md` §1, §5, §6, §7 and §8 patch 1, and its review `AUTOFILL2-PLAN-REVIEW.md` (where the review's patch-1
items differ from the plan, the review's are built). Stage 1 is `AUTOFILL1-NOTES.md`; this patch is built on it with FU and
STORAGEGATE. **No new permission, no content script, no manifest change.**

## 1. What the user sees

- **Alt+Shift+F while Sixkey is locked** (popup mode): the toolbar popup opens by itself (`action.openPopup`) on the lock
  screen, with the PIN or the master-password field focused, and above it one line: _Unlock to fill the code on github.com_.
  Typing the PIN (or the password, or the recovery key) there unlocks Sixkey; the list fills that page's code box, says
  _Code filled. Continue on the page._ and the popup closes about 1.2 s later. Nothing is submitted.
- **Panel mode, panel open:** the line appears in the open panel's lock screen (it watches); the unlock there fills; the
  panel stays and says so. **Panel closed:** the toolbar shows **!** and _Sixkey is locked: open it to unlock_, as before;
  the user's click on the icon opens the panel, which shows the line.
- **Several accounts for the site** (locked, then unlocked there): nothing is filled; the list says _Choose the account to
  fill the code on github.com._ and the first card's Fill button has the focus. **Several accounts while unlocked**, and a
  **plain http page** while unlocked: the popup opens on the list with the Fill button focused (offered), nothing is
  filled until it is pressed; on http the press asks the M5 question as in Stage 1.
- **The page is http** and Sixkey was locked: after the unlock the M5 question is asked; nothing before _Fill anyway_.
- **Every other case fills nothing:** another tab or another window in front, another address in the tab, a lock since
  the key, more than a minute since the key, or a newer press. The line disappears where it no longer holds; if the unlock
  was made under the line and it no longer holds, the list says so (_Not filled: this is not the tab you asked to fill._ /
  _Not filled: the page changed, Sixkey locked, or a minute passed since you asked._ / _Not filled: no account is
  registered for github.com._).
- **"Lock every time":** the same; the popup closing after the fill is the lock, as always in that mode.

## 2. How it works

### 2.1 R, the pending fill request (`src/platform/fill-request.ts`)

`sk_fill_req` in `chrome.storage.session` (memory; trusted contexts only, on every Chrome version):

```ts
{
  v: (1, nonce /* 128-bit hex */, tabId, windowId, url /* full */, host /* URL hostname, ASCII */, at, epoch, why);
}
// why: "locked" | "choose" | "insecure"
```

- **Slim, as the review's m1 asks:** no `documentId`, no frame, no token, no secret, no account. The tab's full address is the
  pin; the surface does its own fresh look. `why` replaces the plan's `surface` field: what the surface may do depends on why
  the shortcut stopped, and the surface knows which surface it is.
- **The only writer of a new R is the worker** (`putRequest`, in the shortcut's run). A surface only removes R, by the take.
- **The take** (`takeRequest`) is a compare-and-delete under `webLock("sixkey-fill-req")`, the checks all inside the lock:
  the nonce the surface showed; `0 ≤ now − at ≤ 60 s`; the lock epoch (`sk_lock_epoch`) unchanged (every lock bumps it; an
  unlock does not); and **R's tab is the tab in front of the surface's own window** (`tabs.query({active: true,
currentWindow: true})`), at the same full address (the comparator of `lookAtFront` and FU's `away`). Then R is removed:
  one use. A refusal leaves R alone (another surface may be the one it is for).
- **Two front-tab checks, no more** (review M1): R's take, and FU's `away` after a wait for the next code. Patch 1 adds no
  tab watcher.

### 2.2 The shortcut (`runShortcut` in `src/background/fill-command.ts`, called by `sw.ts`)

1. The lock epoch, read **before** the vault: a lock during the ≤ 5 s wait for the next code (which `fillOnTab` reports as
   `locked`) moves the epoch on, and so voids the R written below.
2. `fillOnTab`, unchanged.
3. For `locked`, `choose` and `insecure` only, R, written **before** the surface is opened (review M4). Every other outcome
   (filled, no box, no account, blocked, refused, unsure, slow, gated) is final and writes none: an R after a fill could fill
   a second time.
4. `reportFill`, unchanged: the popup (`openPopup`, which needs no gesture) or, in panel mode, the attempt to open the
   panel, which fails after the awaits as it did (AUTOFILL1 m-7). **The plan's panel-mode reorder is dropped** (review M4:
   `action.plan` is undefined on a cold worker); an open panel takes R up by its watch, and a closed one is opened by the
   user's click.

### 2.3 The surfaces

- **The lock screen** (`Locked.tsx`, in the lazy `late` chunk) shows R's line when R is for here (the take's checks but the
  nonce), and looks again whenever R or the lock epoch changes (`storage.session.onChanged`) or the tab in front changes.
  It never writes R. At a successful unlock typed into it, it hands App the nonce of the line **as it was shown at that
  moment** (a ref, not a later render).
- **App** keeps that nonce for the list (`resume`) only from its own unlock. A load that does not end on the list (a lock)
  drops it; no other load sets it: a surface that follows an unlock made elsewhere (the side panel's watch, a popup opened
  already unlocked) never fills by itself (review M3).
- **The Fill chunk's `Resume`** acts once per nonce: for an R from a locked vault and exactly one account registered for the
  page, the take, then the **existing `press(entry)`**, unchanged (review M1): the look, the M5 question, _Which box?_, the
  wait for the next code, FU's `away`, and STORAGEGATE's gate all come with it. Several accounts, no account, or an R that is
  no longer for here: nothing is filled, and one line says why. The popup closes 1.2 s after a press that ended in _Code
  filled_. Without an own unlock, an R for here is only **offered**: the first card's Fill button gets the focus (in the side
  panel only while the panel has the focus), once per R.
- When the surface's own unlock was made for an R and the list has no account for the page, the Fill chunk is loaded anyway,
  so that the "no account" line can be said (its text stays in the lazy catalog).

## 3. Decisions, with reasons

| #    | Decision                                                                                             | Why                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1 | R lives in its own module, `platform/fill-request.ts`, not in `platform/session.ts` as the plan says | `session.ts` is in the popup's counted bundle; importing it from the lazily loaded R module made the bundler re-chunk and grew the counted popup by about 630 B gzip. The module spells `sk_lock_epoch` itself for the same reason (a comment says so) |
| P1-2 | `why` instead of `surface` in R                                                                      | The decision the surface makes depends on why the shortcut stopped                                                                                                                                                                                     |
| P1-3 | No panel-mode reorder                                                                                | Review M4                                                                                                                                                                                                                                              |
| P1-4 | Review m2 (a `visibilityState` check in `fill()`) not taken                                          | Optional; it would touch the Stage 1 finder and its specs drive several tabs headless                                                                                                                                                                  |
| P1-5 | The recovery key typed into the lock screen counts as an own unlock too                             | It is typed into that surface while the line is shown, as the PIN and the password are                                                                                                                                                                 |
| P1-6 | The full address is compared (a hash change ends R)                                                  | One comparator, FU's (review M1); the plan's "without the hash" is not used                                                                                                                                                                            |

## 4. Residuals, stated

- **A closed side panel is not opened by the shortcut**: the user's click on the icon does it (review M4).
- **The popup cannot open** (full screen, another popup open): the tooltip says to open Sixkey; R stays for its minute, and a
  surface the user opens on that tab takes it up.
- **The window-focus check** of the review's M2 is not made (only the own-window rule): it is timing-sensitive headless, and
  the take already requires the surface's own window, which is where the user typed.
- **Real keys and real OS focus** are not testable here: owner checklist item 23.

## 5. Tests

- **Unit:** `autofill2-request.test.ts` (R's exact shape; anything else read back is no R; the take: once, the nonce,
  59.999 s and 60.001 s and a time before R, a lock since, another tab, no tab, another address, two takes at once; peek
  never writes; which outcomes leave R; the shortcut's run: R before `openPopup`, the epoch read before the vault and a lock
  during the run voiding R, R's reason for several accounts and http, no R for filled, no account or gated).
- **e2e** (`autofill2.spec.ts`, the real popup that `openPopup` opens, reached through DevTools): popup + password (line,
  focus, filled, R gone, popup closed); panel open on the PIN (the line arrives, the PIN fills, the panel stays); a second
  window (no line there, nothing filled); the line goes and nothing is filled after a lock, after 60 s, after a navigation;
  a tab switch in the panel; two presses (the line follows the newer R, one fill); http (the question first); several
  accounts unlocked (offered, nothing filled) and locked (the line to choose, nothing filled); unlocked elsewhere (offered,
  filled only by the click); a direct shortcut fill leaves no R; lock every time (PIN, filled, the popup's close locks).
  `visual-guard.spec.ts`: the lock screen with the line, popup and panel, light and dark, en and zh_CN.

**Mutants:** one at a time, behaviour tests only (no source-rule test), **16 mutants, 16 killed**; the two no-change baselines survived. Item 2: P2a (R taken by R.windowId's active tab: unit, and the second-window e2e), P2b (the tab not compared: unit; since P1FU also the e2e V-A, §7), P2c (the address not compared: unit and e2e). Item 3: P3a (any load of the list resumes a fresh R, i.e. a following unlock fills: e2e "unlocked elsewhere"), P3b (the press with Fill anyway: e2e http), P3c (several accounts, the first filled: e2e), P3d (R survives a lock: unit and e2e), P3e (R written for `filled`: unit; R's shape check refuses that reason anyway), P3g (the epoch read after the vault: unit). Item 4: P4a (the popup opened before R is written: unit), P4b (the lock screen does not watch R: e2e). Item 5: P5a (the take does not remove R: unit and e2e), P5b (no 60 s expiry: unit and e2e), P5c (the nonce not compared: unit). STORAGEGATE follow-ups: V3 (unit), SGc (the gate's catch removed: unit). Not run: "a choose or insecure R resumed like a locked one" is equivalent: such an R is written while the vault is open, and an own unlock needs a lock first, which voids it.

**Runs and budgets:** private copies, `nice -n 19`, the shared lock. messages.py (553 messages), typecheck, prod/e2e/dev builds and check-dist, gate open, format:check: clean. Full unit run once: 221 files, 3,231 passed, 4 expected fail, 1 skipped. e2e in a scratch copy with the API port moved off 8787: `autofill2.spec.ts` (14 tests) twice in a row, 28 passed; then `autofill1`, `autofill-engine`, `visual-guard` and `autofill2`: 132 passed, and `visual-guard` failed in both languages on a locator of its new lock-screen state (two fields matched), fixed and run again: 2 passed. Budgets: popup 55,941 B (gate closed; +212 B: static +190, the counted catalog +22 for the lock line), 57,101 B gate open (headroom 4,339), side panel 58,157 B (prod) and 59,321 B (gate open); the lazy parts: the Fill chunk 4,702 B + 466 B, `fill-request` 879 B, the Fill text en 921 B and zh_CN 1,181 B of 4,096 (35 keys). The lock screen's line was looked at, popup and panel, light and dark, en and zh_CN.

## 6. Also in this patch: STORAGEGATE's verify follow-ups (`STORAGEGATE-VERIFY.md` items 4, 6 and 7)

A separate set of hunks, unrelated to R:

- **Wording (MINOR-1):** the `sw.ts` comment on the first import; TOTP-AUTOFILL §4.2's two old sub-bullets marked superseded,
  its §9 Stage 1 row and its §12.1 P1 row answered; AUTOFILL-PRE-NOTES §1.3 and its open-items list (120–139 cannot be closed
  and Stage 1 injects nothing there; 140–144 not probed).
- **NIT-1:** `storageClosed` catches a throw and answers no (unit: a throwing `chrome.storage` getter resolves to `false`).
- **NIT-2, NIT-3:** AUTOFILL1-NOTES §7 and §17: closing those tabs, or restarting the browser, ends the residual; from Chrome
  140 a content script receives no `onChanged` events of the areas either.
- **NIT-4 (the verify's surviving mutant V3):** a press whose own look comes back gated now says the Chrome 140 line under the
  card as well as in the strip (it used to set a note that was not drawn, because the card hides in that state). A unit test
  (an open look, then the tab shows another page and `storage.local` can no longer be closed, then a press) kills V3.

## 7. Patch 2: per-site grants (the plumbing; nothing runs in a page by itself yet)

Inputs: `AUTOFILL2-PLAN.md` §3 (with §3.4, the sync fixes), §4.6, §7 and §8 patch 2, and its review: where the review's
patch-2 items differ from the plan (M7, m3, m4, m5), the review's are built. **No content script is registered**: check-dist
still refuses `registerContentScripts`, `updateContentScripts` and `unregisterContentScripts` everywhere. **Patch 2 is not
releasable without patch 3**: the offer below promises suggestions next to the code box, which patch 3 brings. Release them
together (the offer's text is a draft anyway, pending OQ3).

### 7.1 What the user sees

- **The offer** (the Fill card, popup and side panel): after a fill that put the code into an https page at the default
  port, whose host may be turned on (§7.2) and is not on the list, the card of that account shows once: _Suggest codes
  automatically on github.com?_, the plan's §3.1 body with its _Only on secure (https) pages._ line, and **Turn on for
  github.com** · **Not now**. Turn on shows Chrome's own prompt for that one site; granted: _Code suggestions are on for
  github.com._ Not now, or Deny in Chrome's prompt: not offered again until the browser restarts. Nothing is offered after
  the fill the popup makes for a pending request just before it closes (patch 1's resume), on http (even a granted host's),
  at another port, on an IP address, a shared suffix or the API's host.
- **Settings › Security › Autofill** (`#autofill`, the Security group's fourth leaf, a link under its title): one row
  per site: the host, _On_ or _Turned
  off in Chrome_ (Chrome's grant as Chrome says it now, re-read on every permission event and list change), **Turn on
  again** for a site whose grant is gone (Chrome's prompt, in that click), **Remove** for every site; the lead line on what a
  grant allows (_Chrome lets Sixkey read and change the site's pages; Sixkey looks only for the verification-code box and
  sends nothing anywhere. Secure (https) pages only._); _Chrome keeps this list of sites in its own settings, unencrypted._;
  where storage cannot be closed to pages (Chrome before 140), _Code suggestions need Chrome 140 or later._ and no Turn on
  again (Remove still works). It needs no unlock: nothing in it is the vault's.

### 7.2 How it works

- **Manifest.** prod and dev: `optional_host_permissions: [<API origin>/*, "https://*/*"]`. Optional, so nothing is granted
  at install and Chrome shows no install warning. No http, no `<all_urls>`, nothing required. e2e: required `host_permissions`
  `[<API>, https://grantedtls.fix.test/*, http://granted.fix.test/*]`, two Stage 2 fixture hosts (its tests cannot answer
  Chrome's prompt; plan §3.1, §7.2), and Stage 1's fixture hosts stay ungranted. `minimum_chrome_version` stays `120` (§7.3
  P2-1). check-dist holds all three lists exactly (`HOSTS`), `build.mjs` checks the API comes first, and `https://${host}/*`
  joins the URL templates a shipped script may hold (never fetched: the CSP's `connect-src` is still the API alone).
- **One site is one host over https, at any port:** a pattern without a port, `https://<host>/*`, covers every port of that host
  (Chrome's URL patterns default the port to `*`, P2 verify NIT-1), so a grant is for that site, not for one origin.
- **Which hosts** (`core/autofill-sites.ts`, pure): `siteHostOk`: exactly as the URL parser writes it (`canonicalHost` changes
  nothing: lower case, punycode, no trailing dot, no port, no wildcard), at most 253 characters, not an IP address, not a
  single label (`localhost` among them) or a shared suffix (`isShared`), not the API host. `sitePattern` is the one place
  that builds `https://<host>/*`. `siteOfUrl` offers only an https page at the default port without a user name.
- **The list** (`platform/autofill-sites.ts`, the only spelling of the keys): `sk_af_sites` in `storage.local`,
  `{v: 1, hosts}`, at most 32, every change read and written under `webLock("sixkey-af-sites")` (the popup or panel, Settings
  and the worker are its writers). It is the user's intent: nothing but Remove takes a site off (review m4). Device-local by
  construction: no sync, backup or export code names it (a source rule).
- **The request** (`requestSite`): the first statement of both clicks (the card's `turnOn`, Settings' `again`). It refuses a
  host `siteHostOk` refuses, calls `chrome.permissions.request({origins: [pattern]})` before anything else, and in the same
  synchronous run notes the ask, `sk_af_pending: {v: 1, host, at}` in `storage.session`, without waiting (review M7).
  - The page that asked finishes it (`answered`): granted, the site goes on the list; refused, `sk_af_later`
    (session) keeps it from being offered again.
  - If the popup closed under Chrome's dialog, the worker's `permissions.onAdded` finishes it (`acceptPending`): only if
    Chrome added exactly `https://<pending host>/*` and the ask is 0 to 60 s old. "On all sites" (`https://*/*`), the API's
    origin (sync turned on), another site, a subdomain, http, a stale ask: nothing is added. A stale ask is dropped.
- **Remove** (`removeSite`): off the list first, which is what turns the site off; then `permissions.remove` of the site's
  pattern only if `permissions.getAll()` lists exactly that pattern (`platform/permission-grants.ts grantedExactly`, a
  module that imports nothing, shared with sync's browser-start check, so the popup's lazy Fill chunk takes no sync module
  with it). A broad grant chosen in Chrome's menus stays as the user set it, and a grant Chrome refuses to remove (a
  required one in e2e) leaves the site off anyway.
- **Reconcile** (`platform/autofill-reconcile.ts`), at every worker start, on every `onAdded` / `onRemoved` that names a
  host other than the API's pattern (`beyondApi`; the API's never covers a site), and on a change of `sk_af_sites`
  (`watchList`, which takes nothing from the change but its key, as `action-mode.ts` does):
  1. **The gate first** (review m3): `closedBy(storageAccess)`, storageClosed's rule (both areas accepted
     `TRUSTED_CONTEXTS`, within 5 s, else no) applied to this worker start's own access-level call (§7.3 P2-4). Closed:
     nothing counts; one diagnostics line (`autofill suggestions off: storage access not restricted`) if the list has sites.
  2. **List ∩ granted**: `contains({origins: [https://<host>/*]})` one site at a time. A site withdrawn in Chrome's UI drops
     out at the run its `onRemoved` starts (or the next start's); "On all sites" turns on nothing unlisted.
  3. **The seam**: `apply(hosts)`, which patch 3 makes the one registration (`platform/autofill-register.ts`). Here it does
     nothing.
  - Runs are serialised (a promise chain: only the worker reconciles); triggers that come while a run waits for its turn join
    it; a run still out after 15 s is given up (its later steps apply nothing) and the next starts; any failure applies none.
  - The worker's diagnostics lines are now written one after another (`note` in `sw.ts`): `createDiagOnce` reads then
    writes, so the access-level line and reconcile's would otherwise race.
- **Sync** (plan §3.4 with review m5): `apiPermissionGranted` stays a `contains` of the API pattern. A site's grant never
  satisfies it, and "On all sites" does, as it really lets the API be reached; with sync off nothing is sent anyway (the
  engine reads `sk_sync_cfg` first). `concernsApi` stays "any event that names a host": its comment now says why (both
  handlers ask Chrome again, so a site's event costs one check and changes nothing). `browserStarted` removes the API
  pattern only if `getAll()` lists it exactly (`apiGrantedExactly`), never from under a broad grant. Only the worker side
  changed type (`WorkerChrome.permissions` gains `getAll`); the pages' `removeApiPermission` is unchanged (§7.3 P2-3).

### 7.3 Decisions and deviations, with reasons

| #     | Decision                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1  | `minimum_chrome_version` stays 120 (the plan says 140)                                                                         | OQ1 is the owner's and unanswered; its interim answer is the runtime gate (OWNER-DECISIONS/14). On 120 to 139 reconcile counts no site, Settings says so and asks Chrome for nothing, and the Fill card (whose look is gated) offers nothing. Raising it is one line in `manifest.base.json` (and check-dist's `>= 120`)                                    |
| P2-2  | The list is never pruned                                                                                                       | Review m4: the plan's §3.2 step 4 would make §3.3's _Turned off in Chrome_ row impossible. The sites that count are computed (list ∩ granted) at every run                                                                                                                                                                                              |
| P2-3  | `concernsApi` kept; the exact-grant guard in `browserStarted` only                                                             | Review m5. Not in `removeApiPermission`: the Sync section's page-hide and review give-backs must issue `remove` before they return (`SyncSection.tsx` pagehide, `panel.ts` closeReview; `m6-permission-edges` "given back before anything is awaited"), and an awaited `getAll()` first would break that                                                    |
| P2-4  | Reconcile's gate is storageClosed's rule over this start's own call (`closedBy(storageAccess)`), not a fresh `storageClosed()` | The same rule, fail-closed with the same 5 s; an answer cannot outlive the worker start that asked. A fresh call per run would add `setAccessLevel` calls to every start, against the pinned "the first two calls, once each" (`autofill-pre-storage.test.ts`, `scripts/sw-order.mjs`)                                                                 |
| P2-5  | Settings › Security › Autofill, a fourth leaf of the Security group (`#autofill`), not a panel of the Appearance page        | `SHORT-SETTINGS-NOTES.md` §1 reserved a panel of the Appearance page, but that page is about 1,320 px of the 1,350 px a leaf may have (§6, the visual guard's rule). Any panel there, or a row of leaf links over it (a second Appearance leaf: 1,366 px measured), pushes it over. The Security group already has that row, so a leaf there changes no other page's height; and what the leaf holds is a permission and its consequences (what a grant lets Sixkey do in a page, the list Chrome keeps unencrypted, the storage gate). Its text is in the `misc` part (plan §4.6), its title in `core` (the link under the group's title) |
| P2-6  | No offer at a non-default port, or with a user name in the address                                                            | The pattern asked for covers every port, and patch 3's sender check refuses an origin with a port (plan §4.1): such a page would never get a suggestion                                                                                                                                                                                                 |
| P2-7  | `*.localhost` is not refused by name                                                                                           | A single label (`localhost`) is refused with every other one (`isShared`); IP addresses are refused. A `localhost` literal in the shipped code would also trip check-dist's dev-marker rule                                                                                                                                                             |
| P2-8  | Two e2e fixture hosts, not the plan's three                                                                                    | `grantedauth.fix.test` serves patch 3's frame cases                                                                                                                                                                                                                                                                                                      |
| P2-9  | The offer's words are the plan's §3.1 (_Turn on for github.com_); the path it names is _Settings › Security › Autofill_       | The brief's "Show suggestions on <host>" paraphrases them; the grouped settings put the panel under Appearance. All of it is draft wording, pending OQ3                                                                                                                                                                                                 |
| P2-10 | Not now, and Deny in Chrome's prompt, are one session list (`sk_af_later`)                                                     | Proposal §8.3: a host set in `storage.session`, gone at a browser restart; a refusal is the same answer                                                                                                                                                                                                                                                 |
| P2-11 | The text is a fragment of its own (`scripts/i18n/autofill2sites.py`)                                                           | Patch 1 is still under verify; its fragment stays untouched                                                                                                                                                                                                                                                                                               |
| P2-12 | No `/*` outside block comments in the new and changed modules' line comments (the patterns are described in words there)      | Older source rules (`m2`, `m3`, `autofill-pre-*`) strip comments with a regex that reads `/*` in a line comment as the start of a block, and would then skip the module's imports                                                                                                                                                                       |
| P2-13 | `autofill1-check-dist.test.ts`: its fill-call pattern accepts `$` in a minified name                                            | The grown worker bundle named the fill stub `$l`; the old `\w+` no longer matched it, so that test's own guard ("none of these mutants is a no-op") failed. check-dist's rule itself was unaffected                                                                                                                                                       |

### 7.4 Residuals, stated

- **A page's sync give-back under "On all sites"** calls `remove` of the exact API pattern, which only the broad grant covers.
  Verified in source (P2 verify): the extension's own removal subtracts only that exact pattern, and the broad grant stays.
  Owner checklist item 24 confirms it in a real Chrome.
- **A grant without a list entry**: Turn on answered after more than a minute, with the popup already closed, leaves the
  site granted in Chrome and off the list. It turns nothing on and shows in `chrome://extensions`.
- **Whether real Chrome fires `onRemoved` for a revocation in its own UI** is an owner check. In Chromium 156 the e2e's
  `chrome.developerPrivate.updateExtensionConfiguration` on `chrome://extensions` (what its Site access control calls)
  did: the settings page's listener saw the site go, and come back with the grant. The next worker start reconciles
  either way.
- **The popup closing under Chrome's dialog** (review M7, a Firefox report) is unverified in Chrome; `sk_af_pending` covers it.
- At 32 sites the offer is not shown any more.
- `SYNC-DESIGN.md` §7 still says the manifest has exactly one optional host permission: its next revision should take
  check-dist's rule (proposal §0.7 asks for the same revision to record that autofill state is device-local).

### 7.5 Tests

- **Unit.** `autofill2-sites.test.ts`:
  - `siteHostOk` (canonical only, 253 characters, IP addresses, single labels, shared suffixes, the API host, punycode),
    `sitePattern`, `siteOfUrl`, a list read back (32, duplicates, unknown fields);
  - the request: exactly one origin, before the note, both synchronous; nothing asked for a refused host;
  - the page's and the worker's ends of an ask (the minute's two edges, "On all sites", the API, a subdomain, http, a
    malformed ask);
  - Remove: exact grant, broad grant, a refused remove;
  - reconcile: list ∩ granted, a withdrawal and a re-grant, "On all sites", the gate with its one line, idempotence,
    failures closed, four triggers that never overlap and join the waiting run, a run given up after its time applying
    nothing.

  `autofill2-sync.test.ts`, over the real engine and FakeServer:
  - a site's grant satisfies no API check, and its `onRemoved` pauses nothing;
  - a site's `onAdded` while the API's is withdrawn sends nothing;
  - "On all sites" with sync off sends and writes nothing;
  - `browserStarted` removes only an exact API grant;
  - the reverse (the API is never a site; neither removal touches the other's pattern).

  The other files:
  - `autofill2-sw.test.ts`: the worker's wiring (start, both events, a list change, the gate closed three ways with its
    one line, the worker's end of an ask, the start's first two calls unchanged);
  - `autofill2-settings-dom.test.ts`: the panel (On / Turned off in Chrome, a withdrawal shown at once, Turn on again
    inside the click's gesture, Remove, the Chrome 140 line);
  - `autofill2-grants-rules.test.ts`: the source rules;
  - `autofill1-check-dist.test.ts`: new tamper cases (an optional `<all_urls>`, `*://*/*`, `http://*/*`, a Stage 1 host
    granted in e2e, `https://*/*` granted in e2e, a granted fixture host left out).

  Updated on purpose, because the manifest or the settings page changed:
  - `autofill1-source-rules`: the optional list; `storageClosed` is also asked by `options/Misc.tsx` (the Chrome 140 line;
    it injects nothing);
  - `m5-check-dist`: the e2e and dev messages; the `https://*/*`-instead-of-the-API case kept failing;
  - `m5-source-rules`: host permissions go through `api-permission.ts` (the API), `autofill-sites.ts` (one site's pattern,
    three uses) and `permission-grants.ts` (reads `getAll` only);
  - `autofill-pre-source-rules`: the worker's second `storage.local.onChanged` listener (`watchList`, held to the same
    "key names only" shape as `action-mode.ts`'s) and `options/Misc.tsx`;
  - `budget-split` (16 wrappers), `short-settings-route` and `short-settings.spec.ts` (Security has four leaves; `#autofill`
    lands on it), `visual-guard.spec.ts` (the Autofill leaf is probed at every width, reached by its address: the frozen
    `harness.ts` does not know it), `autofill1-check-dist` (P2-13).

  The worker fakes of seven files gain `getAll` and `storage.local.onChanged`; no assertion changed.
- **e2e** (`autofill2-sites.spec.ts`):
  - popup and panel: fill on `https://grantedtls.fix.test`, the offer, Turn on in a gesture (Chrome answers at once for a
    granted host), the list written and the ask's note gone, Settings On, no second offer;
  - no offer on http (a granted host), at a port, on an IP address; Turn on for an ungranted site refused, then not offered
    again; Not now;
  - Settings: On, Turned off in Chrome, Turn on again refused, Remove (also of a required grant), the empty line;
  - a revocation through `chrome://extensions`' own API, then the grant back.

**Mutants:** one at a time, behaviour tests only (the source-rule file left out), **28 unit mutants, 28 killed**, and **5 e2e
mutants, 5 killed**; the two no-change baselines survived.
- The brief's six:
  - **http origin accepted**: H1, `siteOfUrl` takes http (unit); E-H1, the same in e2e (the http page of a granted host, at
    the default port);
  - **a wildcard or broader origin requested**: W1, the request asks for every https site; W2, `https://*.<host>/*`; W3,
    the API's origin asked too; H2, the pattern is `*://` (http too);
  - **a revocation not reconciled**: R1, grants ignored (the list alone counts); R2, `onRemoved` does not reconcile (the
    worker test); R3 and E-R3, Settings does not listen to `onRemoved` (unit and e2e);
  - **a sync check that accepts any host**: S1, any granted host counts as the API's; S2, `browserStarted` back on
    `contains` (removes from under "On all sites"); S3, `permissionWithdrawn` without its re-check (a site's `onRemoved`
    pauses sync); S4, Remove also gives back the API's pattern;
  - **reconcile run without the gate**: G1, the gate skipped; G2, the worker's gate always open; G3, the gate on `local`
    alone;
  - **reconcile not serialised**: Q1, no chain; Q2, a run given up still applies.
- The others:
  - the worker's end of an ask: P1, no minute; P2, any added origin;
  - P3, Remove without the exact-grant check;
  - `siteHostOk`: V1, the API host; V2, an IP address; V3, a shared suffix or single label; V4, a host the parser would
    rewrite; V5, a port;
  - Settings: U1, On whatever Chrome says; U2, the request after an await (the gesture spent);
  - L1, no cap of 32;
  - e2e: E-V5 (an offer at another port), E-O1 (offered again for a listed site), E-N1 (Not now not kept).
- The review's m4 and m5 mutants ("reconcile not pruning the list", "`concernsApi` back to any host") are not built: both
  describe what this patch does on purpose (P2-2, P2-3).

**Runs and budgets:**
- Every run: private copies, `nice -n 19`, the shared lock.
- Clean: messages.py (562 messages), typecheck, prod, dev and e2e builds with check-dist, format:check, ruff on the
  fragment.
- Full unit run once: 226 files, 3,289 passed, 4 expected fail, 1 skipped.
- e2e, in a scratch copy with the API port moved to 18787 (perl, digit lookarounds, the manifests checked):
  `autofill2-sites`, `autofill1`, `autofill-engine`, `autofill2`, `short-settings` and `visual-guard`, 176 passed.
- Budgets (gzip; the live tree with patch 1, then this patch):
  - popup, gate closed: 55,941 → 55,774 B (static 51,620 → 51,453: `storage-access` moved into a lazy chunk the popup's
    Fill chunk shares with the settings page);
  - popup, gate open: 57,136 → 57,074 B, headroom 4,366;
  - side panel, prod: 58,157 → 57,986 B of 63,488;
  - the lazy parts: the Fill chunk 4,702 → 4,929 B, plus the shared chunk (autofill-sites, storage-access) 1,360 B; the
    Fill text zh_CN 1,181 → 1,442 B of 4,096;
  - settings, zh_CN: core 3,532 → 3,546 of 5,120; misc 1,093 → 1,413 of 3,072; a vault's page 10,903 → 11,158 and every
    part 11,421 → 11,678, of 12,288 (check-dist's measure; messages.py's: 11,152 and 11,673).

## 8. Follow-up AUTOFILL2-P1FU (`AUTOFILL2-P1-VERIFY.md` MINOR-1, MINOR-2, NIT-1 to NIT-3)

- **MINOR-1:** `Locked.tsx` takes the shown nonce from the ref BEFORE it awaits the unlock (PIN, password, recovery key),
  and `own()` takes it as an argument. A request that arrives while the unlock runs was not on screen when the secret was
  sent, so it is not handed on. Unit (`autofill2-lock-line.test.ts`, the lock screen over a minimal document): R changes
  while the unlock is pending; the unlock hands on the first nonce, for the password and for the PIN.
- **MINOR-2:** the line also goes when R's minute is over with no event to say so: after each look that shows R, the lock
  screen looks again at `R.at + 60 s` (+5 ms), and the timer is cleared on the next look and on unmount. Unit, on a fake
  clock: the line is there at 59 s and gone at 60.1 s.
- **NIT-1:** a list that resumed R keeps watching: a later request while it stays open (a side panel; a popup left open)
  is offered like any other. e2e, in a popup left open on the list (the same `Resume` component as the panel's; the panel
  itself is not driven here): "several accounts for the site, locked" goes on with a second press while the list is open
  (focus moved to the search field first): R is `choose`, the first Fill button gets the focus, nothing is filled.
- **NIT-2:** the reviewer's V-A is in `autofill2.spec.ts`: a second window whose tab is moved, in the same document, to
  R's exact address; no line there, nothing filled in either window, R not taken. It gives the tab-ID check an e2e test.
- **NIT-3:** `popupPage` polls for 15 s (a popup the worker opens can take that long on a loaded machine).

**Runs and budgets (P1FU):** private copies, `nice -n 19`, the shared lock. messages.py, typecheck, prod/e2e/dev builds
and check-dist, gate open, format:check: clean. Full unit run once: 222 files, 3,234 passed, 4 expected fail, 1 skipped.
`autofill2.spec.ts` (15 tests) three times in a row, in a scratch copy with the API port moved off 8787: 45 passed.
Mutants, one at a time, behaviour tests only, **5 killed**: F1a and F1b (the nonce read after the await, password and PIN:
unit), F2 (no look at the end of R's minute: unit, on the fake clock), P2b (the tab not compared: V-A), N1 (a list that
resumed stops watching: the longer "several accounts, locked"); the no-change baseline survived. Budgets: popup 55,942 B
(gate closed, +1 B), 57,105 B gate open (headroom 4,335), side panel 58,159 B (prod) and 59,325 B (gate open). No new
screen: a line that goes leaves the lock screen as it is without one, already in `visual-guard.spec.ts`.

## 9. Patch 3: the content script and its channel, without in-page UI (the K3-fallback subset)

Inputs:
- `AUTOFILL2-PLAN.md` §4.1–4.3, §4.6, §6, §7 and §8 patch 3;
- its review: M6, M8 (OQ2's interim answer (b)), m3, m6, m7, m11 and n1;
- `AUTOFILL2-P1-VERIFY.md` item 4 and its NIT-4: the window-focus check and m2 are required here.

The P2 verify's follow-ups are folded in as a set of hunks of their own (§9.5). With this patch, **patches 1 to 3 can ship
together** (the K3 fallback). The offer's text now says what they do: the toolbar badge, then the Fill shortcut. Patch 4,
if K3 keeps it, would bring back "next to the box". All wording is a draft, pending OQ3.

### 9.1 What the user sees

- **On a site turned on** (Settings › Security › Autofill: _On_): after the user's own click or key press in the site's code
  box, Sixkey's toolbar icon shows **1** on that tab. Its tooltip reads _Sixkey can fill the code here: press Alt+Shift+F_,
  naming the shortcut as the user set it, or _open Sixkey_ when none is set.
  - The shortcut then fills as everywhere: Stage 1's path, STORAGEGATE's gate, patch 1's pending request when Sixkey is
    locked. It needs no `activeTab` there: the site's grant lets the worker in.
  - The badge goes at the tab's next page load: Chrome drops a tab's own badge on a cross-document navigation, and keeps
    it across a single-page app's `pushState` [probed, Chromium 156].
- **Nothing in the page**: no element, attribute, style, event or global the page can see. The page gets no answer to the
  script's message.
- **Not on**: an http page, a site not turned on (Chrome does not inject there), a site turned off in Chrome (from its next
  page load), an incognito tab, a page whose own `focus()`, `autofocus` or synthetic events put the caret in the box.
- **Every fill** goes only into the tab in front, and only into a document that is on screen. The tab in front is the active
  tab of the focused window for the shortcut and the side panel, and the front tab of the popup's own window for the
  toolbar popup (P3-5).

### 9.2 How it works

- **The registration** (`platform/autofill-register.ts`, reconcile's `apply`; the only caller of the three registration
  calls). One object:
  - `id: "sk-suggest"`;
  - `js: ["inject/otp.js", "inject/suggest.js"]`, the finder first, in the same isolated world as Stage 1's injections, so
    one finder per page and the same tokens;
  - `matches`: each site that counts, `https://<host>/*`;
  - `allFrames: true`, `runAt: "document_idle"`, `persistAcrossSessions: true`;
  - no `world`, no `matchOriginAsFallback`, no CSS.

  It is registered, updated (only when its sites or files differ) or unregistered, so it is idempotent. Before it
  registers anything it asks STORAGEGATE's gate again, now (`storageClosed`), on top of reconcile's own gate (this worker
  start's answer). Gated, failed, or no site: unregistered. A stale registration (a revocation, a restart with a site
  withdrawn) is removed at the next run. check-dist pins the literal, the three calls (once each, in `sw.js` only) and the
  two files.
- **The content script** (`inject/suggest.js`, built from `src/inject/suggest.ts` and its pure half `suggest-core.ts`). A
  classic script, one function run at once, so no global of its own. It listens in the capture phase, passively (it never
  cancels or changes an event), for `pointerdown` and `keydown`. For each event:
  1. `isTrusted` only, on an `<input>` that can take a code: text, tel, number, password or none; editable; with a size on
     screen. An open shadow root's box is found through `composedPath()[0]`.
  2. At most one look every 2 s per document: `__skOtp.inspect()`, with the finder's own budgets.
  3. The box must be the finder's: `__skOtp.of(el)`, a new three-line export (the token of the box or group an element
     belongs to), names a found box with score ≥ 60, not weak, with room for 6 or 8 digits. On `/otc` the score is 90
     [probed].
  4. Then one message, `{type: "sk-af-cand"}`, with no field, no token and nothing of the page, at most once per page
     address (its hash aside; a single-page app's next address may send again).

  It makes no other `chrome` call. It uses no storage, no network, no timer and no other channel, and writes nothing to the
  page: check-dist's `SUGGEST_FORBIDDEN` holds the built file to all of that, and pins the one call and its message. 586 B
  gzip (limit 6,144).
- **The worker's end** (`platform/content-channel.ts`, the third `onMessage` listener in `sw.ts`). The listener takes only
  the content script's types (`CONTENT_MESSAGES` in `sender-policy.ts`: no row of `MESSAGE_SENDERS`, which never takes
  them, and they never take a page's type). Then, each a reason to do nothing at all:
  1. The sender, from the browser alone (`contentSender`): this extension; a tab with an ID, a window and an address,
     active (review M6, its tab half), not incognito (m11); a document ID, a frame ID, `documentLifecycle: "active"`; the
     frame's origin https at the default port, with its address on it; the top page https at the default port. Every field
     of the message but its type is ignored, so it cannot claim an origin, an address or a tab. All of these fields arrive
     from a registered content script [probed, Chromium 156].
  2. At most 10 messages a minute per tab, in the worker's memory.
  3. This start's storage gate.
  4. The frame's host and the top page's host both on the list and granted.

  Then the badge and the tooltip of that tab. No answer is sent (the listener never keeps the channel open). Nothing opens
  the vault, counts as activity (m6) or is logged.
- **At fill time, for every fill** (popup, side panel, shortcut, a resumed request):
  - `platform/autofill.ts` `fillCand` asks, right before the one call that carries the code and after any wait for the next
    code, whether the tab is still in front, or ends `failed: "tab"` with nothing sent. A failure to ask is a no.
    - The shortcut (the worker) and the side panel ask `inFront`: `tabs.get` plus `windows.get`, the active tab of a
      focused window.
    - The toolbar popup asks `inFrontOfOwnWindow`: the front tab of its own window, the comparator of its look. The
      popup is a widget of its own that takes the activation, so the browser window under it does not report `focused`
      while the user is in it; it closes, and its fill with it, the moment it loses the activation (P3 verify BLOCKER-1).
  - In the page, `inject/otp.ts` `fill` refuses a document that is not on screen (`visibilityState`, review m2): `gone`,
    nothing written, the token not spent.
- **K2 in the content script's world** [probed and in e2e]: `storage.local` and `storage.session` reads are refused ("Access
  to storage is not allowed from this context"), and a page's message types (`sk-clip-arm`, `sk-api`, …) get no answer.

### 9.3 Decisions and deviations, with reasons

| #     | Decision | Why |
| ----- | --- | --- |
| P3-1  | One message only, `sk-af-cand`. No `sk-af-use`, `sk-af-open` or `sk-af-gone`, and no direct fill (`fillOnRequest`) | OQ2's interim answer is (b), under which `use` is gone. `open` belongs with its sender, M9's input protection and P1-verify's MINOR-1, all patch 4's. So in this patch no page message creates R or opens a surface: M6's window-focus check at R creation, M9 and MINOR-1 have nothing to apply to yet. Plan §8 says `use` and `open` are "wired and tested"; that is not done |
| P3-2  | No vault is opened for a page message. "A candidate box with a registered match" is read as: a qualifying box, on a listed and granted site | The list is written only after a registered-tier fill on that exact host (patch 2), and the shortcut checks the registered tier again when pressed. Review §5 and m6: a page message never makes the worker decrypt or count activity. If the maintainers want the match checked against the vault, m6's `lastActive` test and its mutant become required |
| P3-3  | The gate is asked twice before a registration: reconcile's (this start's answer, P2-4) and `storageClosed()` right before registering | "Behind `storageClosed()`", as Stage 1 asks before every injection. It is asked only when there is a site to register, so the start's first two calls are unchanged |
| P3-4  | `cand` gets no answer | The page learns nothing from sending it, not even whether Sixkey is locked. The plan's `{show, host, label?, many?, locked?}` is patch 4's, if its UI needs it (review m7) |
| P3-5  | The window-focus check (`inFront`) is for the fills the worker makes (the shortcut) and the side panel's; the toolbar popup asks for its own window's front tab (`inFrontOfOwnWindow`) | P1-VERIFY item 4 and the review's M2 and M6 scoped the focus check to fills made without a visible surface. The first version asked it at every fill, which the P3 verify found would refuse every popup Fill in real Chrome (BLOCKER-1): `focused` is the native window's key status, and the popup takes it. Headless Chromium reports every window focused, even two at once [probed], so the rule is held by unit tests (`autofill2-front`, `autofill2-popup-front`) and owner checklist item 25 |
| P3-6  | m2 answers `gone` | As review m2 proposed. The page's text for it, _The page changed. Try again._, fits a hidden tab well enough |
| P3-7  | The window's focus is not required for the badge | The badge is per tab and only says the code can be filled. Every fill checks focus anyway (P3-5) |
| P3-8  | The finder gains `of(el)`, not the plan's `el(t)` | Membership is what patch 3 needs, and `of` hands out no element. `el(t)` can come with patch 4's anchoring |
| P3-9  | No MutationObserver, no look at load | Plan §4.3. An `autofocus` box shows nothing until the user clicks or types (the shortcut covers it) |
| P3-10 | The offer's text and the store draft say what patches 1 to 3 do | So that 1–3 can ship as the K3 fallback (the P2 handback said 2 and 3 must ship together; with this text that is no longer so). OWNER-DECISIONS/14 has the drafts |
| P3-11 | The text is a fragment of its own (`scripts/i18n/autofill2cs.py`): the two tooltip keys of the full catalogs, for `chrome.i18n` | Patch 2's fragment holds patch 2's text |
| P3-12 | The browser's registration fake, `commands.getAll`, `i18n` and per-tab badges in `test/helpers/sw-world.ts` | The worker tests need them; nothing else changes for the tests that use the helper |
| P3-13 | `visual-guard.spec.ts`'s stand-in Fill page also answers `chrome.tabs.get` for its stand-in tab: the tab in front of its real, focused window | The product was right: the stand-in faked the front tab (`tabs.query` → tab 1) but not the tab itself, so `inFront` found no tab 1 and refused the fill (the guard's popup "found" step timed out). The check is unchanged; the stand-in is now consistent |

### 9.4 What a page can learn or do (plan §6, as built)

- **A granted site:** nothing from the script. No answer, no write; its looks only read the shape of a few inputs. At
  most it could time the few milliseconds a look takes after the user's click, which says that some extension looked.
- **A compromised renderer of a granted site:** it can send `cand` by itself and so set the badge on its own tab (at most
  10 a minute, then nothing until the minute passes). That is all a message can cause: no code, no fill, no surface, no
  vault opened. Pressing the shortcut then does Stage 1's checks: the registered tier, every frame covered, the box.
- **An ungranted site:** Chrome does not inject there. A renderer that never ran Sixkey's content script and claims to be
  one is ended by the browser [verified, plan F10]. If Stage 1 injected there, the worker still refuses its origin, which
  is not on the list.
- **A frame of a granted site inside another page:** the script runs in the frame (`allFrames`), but the worker refuses
  its message unless the top page's host is on the list too. A fill also needs `candidatesFor`'s M4 rule.

### 9.5 Folded in: the P2 verify's follow-ups (`AUTOFILL2-P2-VERIFY.md`, a set of hunks of their own)

- **V2-1 (MINOR-1).** After Sixkey's own Remove, Chrome keeps the earlier consent, so turning the site on again shows no
  dialog [verified by the verify, in Chromium's `permissions_api.cc`].
  - The offer now says _The first time, Chrome asks you to …_.
  - Settings' line says _Chrome remembers that you allowed it once, so turning it on again does not ask again_.
  - PRIVACY says the same.
  - Checklist item 24 expects no dialog on Turn on after a Remove, and records what `chrome://extensions` still lists.
- **V2-2 (NIT-2).** PRIVACY says once that "On all sites" also lets Sixkey reach its sync server, so with sync on it serves
  as sync's permission too.
- **V2-3 (NIT-3).** §7.4 and checklist item 24: the sync give-back under "On all sites" is now "verified in source: the
  broad grant stays".
- **V2-4 (NIT-5).** A behaviour test in `autofill2-sync.test.ts`: sync on and reachable only through "On all sites"; that
  grant withdrawn means `permission_removed` at once, and given back, a round. It pins why `concernsApi` stays "any host".
- **V2-5 (NIT-1).** §7.2, PRIVACY and the store draft: a pattern without a port covers every port of the host, so a grant
  is one host over https, not one origin.

### 9.6 Residuals, stated

- **Window focus and hidden documents** are held by unit tests and by an engine e2e case with `visibilityState` faked.
  Headless Chromium reports every window focused and every tab visible [probed]; owner checklist item 25 has the real
  windows, and the popup's Fill there (BLOCKER-1's two-minute check).
- **Reconcile's applies are serialised** (P3 verify NIT-1): a run given up while its registration call was out may still
  finish it, and the next run's apply waits for it (at most 10 s) instead of racing it.
- **After a revocation**, the badge already shown stays until that tab's next page load. A page already open keeps its
  content script until it navigates; its messages are then refused (not granted). A document reloaded after the revocation
  keeps an empty world of the extension's, with no script in it [probed, Chromium 156]; a new tab has none.
- **On a granted site's tab, the badge "1"** stands in for sync's global badge until that tab's next page load.
- The rate limit lives in the worker's memory: a worker restart resets it. Its bound is the badge.

### 9.7 Tests

- **Unit:**
  - `autofill2-channel.test.ts`:
    - the content script's logic: trusted only; the input types; the finder's box with score, weak and room; one look per
      2 s; one message per address;
    - `contentSender`: the real shape, and 21 departures refused;
    - the channel: unknown fields ignored; claimed origin, address and tab ignored; not listed, not granted, a frame under
      an unlisted top; the gate; 10 a minute per tab, the 11th not even asking Chrome; not a content script;
    - the badge and tooltip;
    - the registration: the object, idempotence, an update, removal on revocation, the gate asked again, refused hosts;
    - a frame of an ungranted site inside a granted page, claiming the granted origin or address: nothing (it kills C1,
      the "claimed origin trusted" mutant, which the first set of tests let survive: their claiming senders had an
      unlisted top page too).
  - `autofill2-front.test.ts`: `inFront` and the fill refused for a tab behind, an unfocused window, a gone tab, and a
    window left during the wait.
  - `autofill2-popup-front.test.ts` (after the P3 verify): the popup's Fill fills with its window reported unfocused and
    refuses when its window's front tab is another; the side panel's Fill and the shortcut refuse an unfocused window and
    fill a focused one.
  - `autofill2-sw.test.ts`, the worker: the registration at start; a withdrawal and the last one; a stale registration
    removed; gated twice over; the message's badge, with refusals for another site, a page's sender and a page's type.
  - `autofill1-check-dist.test.ts`, 14 new tamper cases × 2 flavours: `MAIN`, `matchOriginAsFallback`, `document_start`, a
    third file, a registration outside the worker, and in `suggest.js` `fetch`, storage, `postMessage`, an attribute, an
    event, a global, another message, another chrome API, the file missing.
- **Updated on purpose:**
  - the sender and listener rules (`autofill-pre-source-rules`: the content table, the third listener's first act, the
    channel's import);
  - `autofill-pre-storage`: the one registered script, three listeners;
  - `autofill1-source-rules`: `chrome.scripting` in two modules, registration in one, `storageClosed` also asked by the
    registration, the finder's file named by both;
  - `autofill2-grants-rules`: the seam calls the registration;
  - `budget-split`: the two tooltip keys are Chrome's;
  - `m5-sw-wiring` and the fill tests' stand-ins: three listeners, `tabs.get` and `windows.get`.

  No assertion was weakened.
- **e2e** (`autofill2-content.spec.ts`, and one case in `autofill-engine.spec.ts`):
  - the content script present on the listed and granted https site, and absent on an ungranted https site and on an http
    page of a granted host;
  - a frame of the granted site in an ungranted page: no badge;
  - the page's `focus()` and synthetic events: no badge; the user's click: badge and tooltip; the page unchanged, with no
    global;
  - the shortcut fills there without `activeTab`;
  - K2 in the content world;
  - a revocation through `chrome://extensions`' own API removes the registration, and after a reload there is no script;
    granted back, there is;
  - the engine refuses a hidden document and fills once it is shown again.

**Mutants:** one at a time, behaviour tests only; **17 unit mutants and 5 e2e mutants, all killed**; the two no-change
baselines survived.
- The brief's eight:
  - G4, registration without the gate (unit, and the worker tests);
  - U3, registration for an ungranted origin (unit; E-U3 in e2e, through the worker's own registration);
  - C1, a claimed origin trusted: it survived the first set, whose claiming senders had an unlisted top page too, and is
    killed by the frame case added in §9.7;
  - L2, the rate limit removed;
  - F1, page-driven focus accepted (unit; E-F1 in e2e);
  - F2, the focus check removed;
  - E-M2, m2 removed (e2e, the engine);
  - S5, stale registrations not removed on revoke (unit; E-S5 in e2e).
- After the P3 verify (BLOCKER-1, NIT-1), killed by `autofill2-popup-front` and `autofill2-channel`:
  - P1, the popup's Fill asks `inFront` again;
  - P2, the side panel's Fill asks only its own window;
  - P3, the shortcut's fills ask only the own window;
  - N1, the registration's applies not serialised.
- The others:
  - A1, a background tab accepted; A2, an incognito tab; A3, a prerendered or cached document;
  - A4, the top page not checked (unit; E-A4 in e2e);
  - Q3, no score threshold; Q4, a message at every interaction.

**Runs and budgets:**
- Every run: private copies, `nice -n 19`, the shared lock.
- Clean: messages.py (564 messages), typecheck, prod, dev and e2e builds with check-dist, format:check, ruff on the
  fragments.
- Full unit run once, after the P3 verify's fixes: 230 files, 3,361 passed, 4 expected fail, 1 skipped.
- e2e, in a scratch copy with the API port moved to 18787: `autofill2-content`, `autofill2-sites`, `autofill1`,
  `autofill-engine`, `autofill2`, `short-settings` and `visual-guard`.
  - First batch: 180 passed, 2 failed. The two were `visual-guard`'s popup Fill step in both languages (P3-13); after its
    stand-in was completed, `visual-guard` passed, 2 of 2.
  - After the P3 verify's fixes: 181 passed, 1 failed. The failure was Stage 1's "a page the browser gives no address
    for", a side-panel check on a failed load that this patch does not touch. Run again 4 times, it passed 4 of 4 (the
    machine's load average was 12 to 14).
- Budgets (gzip, the live tree with P2 and P1FU, then this patch):
  - popup, gate closed: 55,775 B;
  - popup, gate open: 57,072 B, headroom 4,368;
  - side panel, prod: 57,986 B of 63,488;
  - `inject/suggest.js`: 586 B of 6,144;
  - `inject/otp.js`: 6,087 B of 8,192;
  - settings, every part: 11,721 of 12,288 (check-dist); misc part 1,456 of 3,072; the Fill text zh_CN 1,498 of 4,096.


## 10. Since wave 1b of the plugin platform (2026-10-24)

Autofill is now the platform's built-in official plugin (`docs/design/notes/PLUGINS-W1B-NOTES.md`). What changed here:

- `scripting` is optional. The first Fill click asks for it in that click. Turning a site on asks for it with the site
  (`requestSite`: `{permissions: ["scripting"], origins: [pattern]}`). Without it, the popup and side panel show the Fill
  button but no strip, the shortcut opens Sixkey at that button (R's `why` is "choose"), and the worker registers
  nothing.
- The code comes from the platform's gate (`platform/plugins/autofill-gate.ts`), never from `fillCand` itself. The
  shortcut's "locked during the wait" is now the gate's "locked".
- Reconcile asks the access gate first, then whether autofill is on and `scripting` is held. Off applies none, and
  without `scripting` nothing is even tried. The worker also reconciles on every permission event that names
  `scripting`.
- Off, in Settings, writes the switch and keeps the list. The worker then unregisters the content script, gives back
  each listed site's grant, and only then `scripting`. The order matters because Chrome keeps running a registration
  left behind wherever a grant remains (probed). While autofill is off, Settings › Security › Autofill shows no status
  on the sites' rows and no "Turn on again"; the switch at the top of that page is how to turn it on. The popup and the
  shortcut do not look at pages while it is off.
- Chrome 140 is the minimum. STORAGEGATE stays as a second layer: "Autofill needs Chrome 140 or later" now appears only
  where a browser still refuses to close storage.

## 11. Follow-up AFSWITCH: the content script's message asks Autofill's switch (2026-11-01)

Found while planning patch 4 and confirmed by that plan's independent review (its S-1).

- **What was wrong.** Off unregisters the content script and gives back each listed site's own grant, and keeps the list
  (§10). Two things outlive it:
  - A page already open keeps its content script until its next load (§9.6).
  - A broad grant the user chose in Chrome's own menu ("On all sites") stays as the user set it, and `siteGranted` counts
    it.

  So such a page's `sk-af-cand` still passed the channel's checks (the gate, the list, the grant), and set the badge "1"
  after Off. Nothing was filled: the shortcut and the popup's Fill ask the switch through the platform's gate. The badge
  was stale, and PRIVACY's "stops the script" was true only from each page's next load.
- **The fix.**
  - `platform/content-channel.ts` asks `off()` (`plugins/autofill-switch.ts` `switchedOff`, handed in by `sw.ts`) right
    after the rate limit, before the storage gate, the list and Chrome. A failure to read the switch counts as Off.
  - The outcome is `"off"`: no badge, no tooltip, and Chrome is not asked.
  - It is read at every message, so On again works without a worker restart.
- **Docs.**
  - PRIVACY: Off stops the script "from each page's next load". Until then a page already open keeps it: a click in its
    code box still lets it look for the box, but Sixkey ignores what it sends. "Opening Sixkey does not look at pages"
    replaces the earlier "does not look at pages", which a page already open made untrue (the review's recheck).
  - ARCHITECTURE: the channel's checks name the switch.
- **Tests.**
  - `autofill2-channel.test.ts`:
    - Off gives `"off"`, with the switch read first and the gate, the list and Chrome not asked;
    - On again badges;
    - a switch that cannot be read counts as Off;
    - a message over the rate limit reads nothing.
  - `autofill2-sw.test.ts`: the real wiring, with only `switchedOff` replaced. Under `https://*/*`, a listed site's
    message sets no badge while Off, and does again once On.
- **Mutants, both killed by assertion:**
  - S1, the channel's switch check removed;
  - S2, `sw.ts` handing the channel `async () => false`.
- It holds nothing of patch 4 and ships with patches 1 to 3.

## 12. Patch 4a: the worker's end of the in-page suggestion, and Sixkey's own surface for it (2026-11-02)

**Inputs:**
- the patch 4 plan (r3), and its two independent reviews (their M-1 to M-5, S-1 to S-11, N-1 to N-9 and R2-M1);
- the owner's OQ2 (b): the click on the suggestion opens Sixkey's own surface and never fills by itself;
- the code review of 4a (its MUST 1 and 2, SHOULD 3 to 7, and NITs), done in r2.

Patch 4a is the part with no page UI: nothing sends `open` yet (4b draws the suggestion). **With the release gate closed, a
store build is byte for byte the one before it**, `_locales` aside (§12.1).

### 12.1 What the user sees

**Store build: nothing changes.**
- The in-page suggestion has a release gate of its own: `scripts/suggest-ui.mjs`, `SUGGEST_UI_IN_STORE_BUILD = false`,
  pinned by `suggest-ui-gate.test.ts`.
- With it closed, every built file of a prod build is identical to the base's, the same names and the same bytes, but for
  `_locales/{en,zh_CN}/messages.json`. Those hold two keys more (`pinLength`, `afSugGo`: +150 and +160 B raw, +30 and +44 B
  gz). The full catalogs are generated once for every build (`scripts/messages.py`), counted in no budget, and read by no
  code in that build.
- check-dist fails a store build in which any script names one of the gate's marks (§12.2), and a dev or e2e build that
  lacks one.
- The gate opens (4d) only after the owner's store draft upload and real-Chrome checks.

**Dev and e2e builds** (the gate open), once 4b draws the suggestion: its click opens the popup (or the side panel, if the
toolbar icon opens it), in that tab's window.
- **Unlocked:**
  - The account's Fill button has the focus, with the line _Press Enter to fill the code on github.com_ (`afSugGo`). During
    the surface's input delay the button is drawn disabled.
  - Enter, or a click, fills the code into the document that was clicked, its top frame only, or into nothing. That holds
    on the "which box?" path too. The popup closes 1.2 s after _Code filled_.
- **Locked:**
  - The lock screen's line reads _Unlock to fill the code on github.com_ (patch 1's).
  - The PIN at a normal pace sends itself at its length. So does Touch ID pressed once the line has been there 600 ms, and
    a password typed after the delay is sent at once.
  - The unlock fills once for one account, and the popup closes.

### 12.2 How it works

Everything below is compiled in only with the gate open. Each module that branches on it reads `__SUGGEST_UI__` as a
constant of its own (`suggest-ui-gate.test.ts`):
- `sw.ts`, `content-channel.ts`, `sender-policy.ts` and `fill-request.ts`;
- `App.tsx`, `Locked.tsx` and `Fill.tsx`.

With the gate closed, each of them folds to the base's code, and the helpers (`content-page.ts`,
`content-page-worker.ts`, `page-open.ts`, `page-delay.ts`, `page-lock.ts`, `page-fill.ts`) are in no build. They do no
work at import, so nothing keeps them.

**The worker**
- **`sender-policy.ts`:** the `sk-af-open` row.
- **`content-channel.ts`:** patch 3's channel and AFSWITCH's, untouched, with one gated hand-off. With a suggestion's
  worker end given, the channel is **`content-page.ts`**'s. Its order:
  - `cand` is answered after the same checks: `{show: true, key}` for the top frame, `{show: false}` otherwise. The answer
    is the same whether Sixkey is locked or not; nothing there reaches the vault. A document answered `show: true` is
    recorded in memory and in storage.session (`page-open.ts`, `sk_sug_shown`: at most 64, ten minutes each; a document
    answered again moves to the end, keeping its "opened").
  - `open`, in order: the sender and the shared rate limit; the top frame; in panel mode, `sidePanel.open` before
    anything is awaited, for a document this worker has answered and not opened. Then awaited:
    1. the switch, the storage gate, the list and the grant;
    2. that document's record, marked opened (one open per document);
    3. a token of the tab's bucket (`sk_sug_open`: two at once, then one per 30 s);
    4. the tab in front of a focused window (M6);
    5. the lock epoch and R v2, written before the popup;
    6. in popup mode, `action.openPopup({windowId})`;
    7. the badge.

    `open` is never answered.
  - A worker started since the answer has no record in memory. In panel mode its click gets R and the badge, and the
    icon opens the panel with R offered (R2-S2, stated).
- **`content-page-worker.ts`:** the real APIs. `sw.ts` builds the gate's channel from it, and imports it after the modules
  it shares with the rest, so the gate-closed bundle keeps the base's module order (§12.3 P4a-12). Its content listener is
  one `addListener` whose argument the gate picks: patch 3's arrow, or the one that keeps the channel open for `cand`'s
  answer only, for a sender that is the content script.
- **R v2 (`fill-request.ts`):**
  - v1's fields, `v: 2`, `why: "page"` and `doc`, the top frame's documentId (32 upper-case hex digits, a new one at every
    load [probed, Chromium 156]).
  - Read (`readV2`) and written only with the gate open. A gate-closed build, like a Sixkey before v2, sees no request in
    it.

**The surface**
- **The input delay (`page-delay.ts`; M-3):** one clock per surface document.
  - It is started by App at the document's start, and by the screens that ask it (idempotent; a later start only makes it
    stricter).
  - It uses SDK §6.4 item 4's 600 ms (`ui/input-delay.ts`, the one constant `ui/plugins/delay.ts` uses too).
  - It is armed at the start, on window focus (not the focus a press in the document brought), on visibility, and when a
    page R reaches a surface already open. Any key or pointer press during it re-arms it, except a character typed into a
    secret field.
  - **A press counts only if it began after every arming since and was no key repeat.** These are timestamps. r1 lost
    them at a re-arm, so a press down inside the delay and up after it counted: the code review's RV1 and RV4.
- **The Fill chunk (`Fill.tsx`, `page-fill.ts`):**
  - An offered page R binds the next press: R taken (the compare-and-delete), then `frameId === 0 && documentId === doc`
    filled, or nothing (_The page changed. Try again._). A choice of box keeps the document: the boxes offered are that
    document's top frame's, and the one chosen is checked against it.
  - A take that fails says why and fills nothing; the next press is ordinary (S-2).
  - **The binding goes with its request** (SHOULD 3): when R is removed or replaced, its minute is over (also at the
    press, timer or not), a lock comes, or the side panel's tab changes. Only when the page under it changed in the same
    tab is it kept, so that press says so.
  - The focus moves to Fill unless a key or click reached the surface within 600 ms (M-2).
- **The lock screen (`Locked.tsx`, `page-lock.ts`)**, only while a page R is on it:
  - nothing is sent during the delay, nor for a press begun in it;
  - an entry sends itself at the PIN's length only if it began after the delay and no wrong secret was typed on this
    screen (R2-M1 a);
  - any other entry, the PIN's, **the master password's** or the recovery code's, is sent by Enter only after 600 ms with
    no character typed into it (b);
  - an Enter-sent PIN of another length than the PIN's (the record's `digits`) is cleared with _Your PIN has N digits.
    Type it again._ (`pinLength`) and not tried (c);
  - the R handed on with the unlock is the one on screen at the entry's first character, or at the device button's press.
    It is handed on only if it had been on screen 600 ms by then, with the delay over, and is still the one shown (M-2).
    Otherwise it is only offered.

  The shortcut's R (v1) and an unlock with no R are exactly as before.
- **Text:** `pinLength` and `afSugGo` are popup keys, looked up only as `SUGGEST_UI && t(...)`. `scripts/catalog-keys.mjs`
  rule 5, now for this gate too, keeps both out of a gate-closed popup's catalog.

**check-dist's marks, both ways.** With the gate closed, no shipped script may name any of these; with it open, each must
be where it belongs:
- `sk-af-open`, `[0-9A-F]{32}` (v2's document) and `sk_sug_shown`, in `sw.js`;
- `fill-page-go`, in the Fill chunk;
- `pinLength`, in the popup's catalog chunks and the lock screen's;
- `afSugGo`, in the popup's catalog chunks and the Fill chunk.

### 12.3 Decisions and deviations, with reasons

| #      | Decision | Why |
| ------ | --- | --- |
| P4a-1  | The gate's define in every build; check-dist's marks both ways | M-1: with the gate closed, a store build has no page-reachable path that opens a Sixkey surface. The suggest.js IIFE gets its define and graph guard in 4b, with the files they guard |
| P4a-2  | **Revised in r2: all of 4a is behind the gate**, the popup's and the lock screen's parts included; a gate-closed prod build is the base's byte for byte, `_locales` aside | The code review's MUST 1. r1 called the surface's part "inert without a page writer", but its input delay ran listeners and a timer in every store popup, and 4a cost the store popup 376 B for nothing |
| P4a-3  | One open per document, after `show: true`; a bucket of 2, then 1 per 30 s, in storage.session | M-4 and the recheck |
| P4a-4  | Panel mode: `sidePanel.open` only for a document in the worker's memory | S-3a. A cold worker gets the badge path (R2-S2, stated) |
| P4a-5  | Characters typed into a secret field during the delay are kept and do not re-arm it | Dropping or re-arming on them would turn a fast, legitimate PIN into a wrong one. The recheck agreed |
| P4a-6  | **Revised in r2: R2-M1 (b) applies to every typed secret**, the master password included | The code review's SHOULD 7. A wrong master password is recorded as `unlock_failed` and brings the failed-attempts notice, so a forged `open` that catches the user typing their site password could plant a false record. A normal pace costs nothing: only an entry begun inside the delay, or after a wrong secret here, waits for its quiet |
| P4a-7  | The delay check comes after `askScripting`, the click's first statement | The W1b rule stays. `scripting` is held wherever a page R can come from |
| P4a-8  | The storage.session keys are `sk_sug_*` | `sk_af_*` keys are spelled only in `platform/autofill-sites.ts` |
| P4a-9  | `INPUT_DELAY_MS` in `ui/input-delay.ts`, re-exported by `ui/plugins/delay.ts` | One constant for one threat, without the popup importing the plugin platform's code |
| P4a-10 | Helpers make their state at first use (a lock, a set) | Nothing at import, so a gate-closed build drops them |
| P4a-11 | `pinLength` is a new popup string | (c) needs a line. The code review agreed with the words |
| P4a-12 | The gate's worker modules are imported by `sw.ts` after the modules they share | An import made earlier (r1: `content-channel.ts` → `fill-request.ts`) moved a base module in the bundle, which renamed the rest of `sw.js` |
| P4a-13 | `afSugGo` is a popup key, not a Fill-catalog key | The Fill catalog must equal its `catalogs/` file (check-dist). As a popup key, rule 5 drops it with the gate closed, and the Fill catalog stays the base's |
| P4a-14 | A press counts only if it began after every arming since (timestamps) | The code review's RV1 and RV4 survived r1: a re-arm cleared the press's own flag |
| P4a-15 | The binding is dropped by its request's removal, replacement, minute, a lock, or the panel's tab change, and kept when only the page changed | SHOULD 3, and S-2's first-press message kept |
| P4a-16 | Both `sw.ts` content listeners are one top-level `addListener` with the gate picking the arrow | Listeners are registered at the top level (`autofill-pre-storage`), and the gate-closed bundle is then the base's call |

### 12.4 What a page can do, as built

- **A granted site's own script** cannot send messages; under (b), its worst case is a popup the user asked for.
- **A compromised renderer** can forge `cand` and `open`:
  - each `open` needs a fresh document answered `show: true`, one per document and two a minute per tab;
  - each is then behind the delay (nothing is sent during it, a stream never lands);
  - behind R2-M1: **at most one PIN try, or one failed-unlock record, per forged `open`**, and the user sees it (the
    shake, on a lock screen naming the page). Five such opens end the PIN and Touch ID until the next master-password
    unlock;
  - behind M-2: an R that arrives while the user types, or just before Touch ID, is offered, never filled;
  - it learns nothing of the vault from any answer.

### 12.5 Tests

**Unit, new:**
- `autofill4-request`: R v2 exact, gate open; neither read nor written, gate closed; one open per document; the bucket.
- `autofill4-delay`: nothing at import; the clock; re-arm by input; the secret-character exception; repeats; focus.
- `autofill4-channel`: both gates; the `cand` answer; the `open` order and refusals; the panel before any await; the cold
  worker.
- `autofill4-sw`: the real wiring, both gates.
- `autofill4-lock`:
  - the normal pace; R2-M1 (a) to (c), and (b) for the password;
  - M-2, for typed secrets and **for Touch ID** (pressed 200 ms after R appeared: not handed on; 700 ms: handed on);
  - a press down inside the delay and up after it;
  - a re-arm after the line was up;
  - the gate closed;
  - v1 unchanged.
- `autofill4-surface`:
  - the offer; the delay, and a press down inside it and up after;
  - `doc` and frame 0; the "which box?" path;
  - S-2;
  - the binding's end: minute, replacement, lock, the panel's tab;
  - the focus; the re-arm on arrival; the resume;
  - the gate closed.
- `suggest-ui-gate`.

**Extended:**
- `autofill1-check-dist`: the gate both ways, on the real builds.

**Updated on purpose:**
- `autofill-pre-source-rules`: the gated content row; the content listener's two arrows; the importers of the channel
  and the sender policy;
- `plugins-w1b-source-rules`: the resumed press's three forms, all in `resumeFill`.

No assertion was weakened.

**e2e** (`autofill4-page.spec.ts`, new, from the code review's probes): a real popup and a real R v2.
- Locked: the PIN at a normal pace fills that document.
- Unlocked: Fill is drawn disabled, focused, and fills after the delay.
- A PIN typed inside the delay is kept and not sent; Unlock after the quiet; R only offered.

**Mutants:** one at a time, behaviour tests only. **44 unit mutants and 4 of check-dist's, all killed by assertion,
  none by a timeout**, among them the code review's RV1 to RV4.
  - M-2:
    - N1, the nonce on screen at submit; N2, the 600 ms on screen at the first character dropped;
    - RV3, the delay's term at the first character dropped;
    - RV2, Touch ID hands on whatever is on screen.
  - M-3:
    - RV4 and RV1, "the delay is over" enough on the lock screen and in Fill;
    - M6a, sent during the delay; M6b, the device button not held; F1, a Fill press during the delay counts;
    - D2, no re-arm by input; D3, digits re-arm; D5, a press before an arming counts after it;
    - F3, no re-arm when R reaches an open surface.
  - R2-M1: D4, auto-send with the first digit in the delay; L1, (a); L2, (b); L2p, (b) for the password; L3, (c).
  - The surface:
    - S2, a take that fails falls through;
    - P1, the document but not frame 0; P2, no `doc` filter; P3, the "which box?" list not held to it;
    - F2, the focus moved while busy;
    - C1, the binding never dropped; C2, dropped when only the page changed; C3, an expired binding kept.
  - The worker:
    - O1, `open` with the gate closed; O1b, v2 read with it closed; O1c, the page channel with it closed;
    - O2, more than one open per document; O3, no `show: true` needed; O4a, the bucket not asked; O4b, the bucket never
      empties; O5, the panel without the record;
    - W1, no tab-in-front check; W4, the panel after an await; W5, the popup before R; W6, `open` skips the checks;
    - W7b, `cand`'s channel kept open with the gate closed.
  - R1, v2 not held to v1's fields; R2, `doc`'s format unchecked; G1, the gate opened in the store build.
  - check-dist:
    - a store `sw.js` that names `sk-af-open`, or a store popup catalog that names `pinLength`;
    - an e2e `sw.js` that lacks `sk-af-open`, or an e2e Fill chunk that lacks `fill-page-go`.
  - Re-runs: P2, whose first form matched twice. R1 and R2, after `readV2` dropped a field check that v1's own reader
    already makes (R1 had survived as an equivalent mutant). O1b, with them.
  - Not run:
    - the lock screen's rules called with the gate closed: equivalent in behaviour, since no v2 can be read then; held
      by check-dist's marks and by the byte comparison;
    - P4, the chosen box unchecked against the document: no test reaches such a box that the filtered list lets
      through.

**Runs and budgets:**
  - Every run: private copies, `nice -n 19`, the shared lock, timeouts of at most 180 s (the full unit run 2,700 s).
  - Clean:
    - `messages.py`, typecheck, `format:check`, ruff on the fragment;
    - the prod, e2e and dev builds with check-dist.
  - **The prod build with the gate closed, against 5139ba8's:** every file identical but `_locales` (§12.1). The worker
    is 102,771 B gz, the popup 58,394 and the side panel 60,625: all the base's.
  - Full unit run, once, at the end: **324 files, 5,212 passed, 4 expected fail, 1 skipped**, 1,262 s.
  - e2e on the e2e build, fixture servers on fixed ports in a run copy:
    - `autofill4-page` 3/3, `quick-pin` 9/9, `pin-restart` 13/13, and `autofill2` 15/15 (in four line groups);
    - `perf`: _whole open 7 (42,812 B), session 6, local reads up to the first code 4_, as on 5139ba8. 4a adds no read,
      even with the gate open.
    - `autofill4-page` and `perf` were run again on the final code. The others ran before `readV2`'s last
      simplification, which is equivalent and leaves v1 untouched.
  - Budgets with the gate open (gzip, 5139ba8's e2e build, then this patch):
    - worker: 101,738 → 103,171;
    - popup: 59,131 → 59,567;
    - side panel: 61,380 → 61,817, the tightest, with 1,671 left;
    - `inject/suggest.js` and the Fill text: unchanged.

### 12.6 Residuals, stated

- 4b brings the page UI, its K3 set, the suggest.js IIFE's define and graph guard (R2-S1), and their e2e tests.
- Real Chrome checks (patch 4c's checklist items): the popup's focus after `openPopup`; the panel's after
  `sidePanel.open`; the cold worker in panel mode.
- 4c: PRIVACY and ARCHITECTURE list `sk_sug_shown` and `sk_sug_open` (IDs and times, storage.session), and ARCHITECTURE's
  `sk_fill_req` line names the page's request.

### 12.7 Follow-up 4A-FU (the 4a-r2 recheck's S-1, N-1 to N-3; 2026-11-02)

- **S-1:** `autofill1-check-dist` tampers with every gate mark, both ways, on the real builds. In a store build that names
  them, each mark's own failure appears; in an e2e build that lacks them, each one's appears too. A first case checks that
  the test's marks are exactly check-dist's, so a mark dropped from either fails.
- **N-1:** `autofill4-surface` covers the weak-box button while a page's request is bound: its box in another frame,
  while the clicked document's top frame has a box that cannot take the code. Pressed, nothing is filled, with _The page
  changed. Try again._ The recheck's RV8 (`pressRun`'s check of a chosen box against `doc` removed) is killed by it.
- **N-2:** check-dist's seventh mark is `lastPress`, the input delay's own property (`popup/page-delay.ts`). It is
  required in the boot chunk with the gate open, and refused everywhere with it closed.
- **N-3:** check-dist names the `[0-9A-F]{32}` mark as generic text, whose false hit would fail closed. The repeated
  comment in `autofill-pre-source-rules` is gone.
- **Gates:**
  - typecheck and `format:check`;
  - `autofill4-surface` and `autofill-pre-source-rules`: 25 tests;
  - `autofill1-check-dist`: 122 tests, 154 s;
  - RV8 run against the new test: killed by assertion.

## 13. Patch 4b: the in-page suggestion, drawn and hardened (2026-11-02)

**Inputs:**
- the patch 4 plan (r3): TOTP-AUTOFILL §4.5 items 1 to 7 as revised (IntersectionObserver v2 for 800 ms, the rendered-size
  rule, the font stack, S-7's restart, the tamper observer, `elementsFromPoint`), its §9.3 (the K3 set, r2 and r3) and
  R2-S1 (the graph guard);
- patch 4a (§12), whose worker answers `cand` and opens Sixkey's surface for `open`.

**With the release gate closed, a store build is byte for byte the one before it**, `_locales` aside (§13.1). Patch 4b
touches no worker module, no surface, and neither `fill-request.ts`, `page-open.ts` nor the shortcut's code.

### 13.1 What the user sees

**Store build: nothing changes.**
- `inject/suggest.js` is patch 3's file, byte for byte: the release gate closed, the suggestion's modules are not even
  loaded (§13.2, the graph guard).
- Every other built file is identical too, but for `_locales/{en,zh_CN}/messages.json`, which hold two keys more:
  `afSugFill` and `afSugNo` (+112 and +116 B raw, +21 and +23 B gz). As 4a's two, they are generated for every build and read by no code in
  that one.

**Dev and e2e builds** (the gate open), on a site the user turned on, after **the user's own** click or key press in a
code box the finder names:
- just under the box (over it when there is no room), at its start edge: **"Fill code with Sixkey · github.com"**
  (_用 Sixkey 填入验证码 · github.com_), and a small **×** (_Not now_, _暂不_). The host is the page's own, in a `<bdi>`;
- for its first 800 ms it is drawn quieter (`#7d97c4`, an arrow cursor), then in Sixkey's blue with a pointer cursor;
- its click opens Sixkey's popup, or the side panel (4a), once in that document; nothing is filled until the user says so
  there;
- Esc or × dismisses it for the document; a click anywhere else hides it until the next look; a refused click changes
  nothing;
- never in a frame, never over a box in a modal dialog or a page whose root is inert (the worker is still asked: its
  badge says the toolbar icon fills), never because of the page's own focus or events;
- its words are the browser's language (`chrome.i18n`), as the toolbar badge's.

### 13.2 How it works

**`src/inject/suggest.ts`** reads the gate as a constant of its own. Closed: patch 3's listeners, unchanged. Open:
`startSuggestion(finder)` and none of patch 3's (the suggestion's own `cand` tells the worker, which sets the badge).

**`src/inject/suggest-ui.ts`** (the DOM; the gate open only):
- **Its element:** `sixkey-suggest`, appended to `document.documentElement` (a hidden `body` would hide it), with a
  **closed** shadow root. Inside, a `popover="manual"` (the top layer: the page's opacity, filters, clips and transforms
  do not reach it) holding the button, the × and a polite live region.
- **Its stylesheets** (adopted: the base, the idle look, the position). Every declaration is `!important`, which in a
  shadow tree wins over the page's own `!important` on the host. `:host{all:initial}` and each element's own reset; the
  font is `system-ui,sans-serif` only (a page's `@font-face` cannot take a generic name); its own cursor.
- **Nothing of its own is drawn over the button**, a shadow included: IntersectionObserver v2 counts any such paint as
  covering it. The × has no shadow, and the live region sits under the box (found by the e2e set: the first build was
  never armed).
- **Armed** (`suggest-arm.ts arming`): IntersectionObserver v2 (`trackVisibility`, `delay` 100, threshold 1) has said
  `isVisible`, all of it, for 800 ms without a break. The clock starts again:
  - when it moves (a rAF loop follows the box, or its group of 6 or 8);
  - when a page top-layer element in the light DOM is toggled over its place (`beforetoggle` and `toggle`, captured at
    the document, its rect against the button's);
  - at `fullscreenchange`;
  - **when the page holds its rendering:** its own frames stop for more than `GAP_MS` (250 ms), or a view transition is
    running (`:active-view-transition`). A held page leaves a frozen picture on the screen, and IntersectionObserver
    reports nothing meanwhile (§13.3 P4b-1).
- **Full size** (R2-S3): the button's effective zoom (`currentCSSZoom`) and rendered height at least 0.8 of its design
  (32 px). Drawn armed only when armed, fresh and full size.
- **A click** reads what IntersectionObserver has not reported yet (`takeRecords`), then `judge`, in order: used,
  untrusted, hidden (a pending record says covered, or not seen whole), small, early, stale (its frames stopped, or a view
  transition), and, from a pointer (`detail` > 0), no trusted pointerdown on the button (`nopd`) or Sixkey's host not first
  at the pointer (`hit`). From the keyboard or a screen reader, armed is enough: the button never takes the focus
  (`tabIndex` -1, its presses' default prevented), so a page cannot make a key its click.
- **Open:** `{type: "sk-af-open"}`, sent in the click itself (the side panel needs its gesture), and the suggestion ends
  for the document.
- **Tamper:** any attribute change on its host, its host removed or moved, the root element replaced, `document.open()`:
  ended for the document (`end:tamper`).
- **The page's events:** only trusted pointerdown and keydown are read, captured and passive; Esc alone is consumed, and
  only while it is shown.

**`src/inject/suggest-arm.ts`:** the pure rules, each with its unit test: `readAnswer` (exactly `{show: true, key}` or
`{show: false}`; anything else is no answer and is asked again), `arming`, `fullSize`, `judge`, `meet`, `place`.

**The build:**
- `scripts/build.mjs`: the content script's build gets the shared define (`__SUGGEST_UI__`) and `__SUGGEST_DBG__`, the e2e
  build's record of the suggestion's decisions for its tests (`__skSugLog`, in the content script's own world);
- `scripts/suggest-guard.mjs` (R2-S1), first among the plugins (`enforce: "pre"`). With the gate closed, `./suggest-ui`
  and `./suggest-arm` from `src/inject/` resolve to an empty module, and a build whose module graph holds either module
  all the same fails. A static import behind a dead branch still loads its module, so tree-shaking alone is not the guard.

**check-dist, the gate open** (`checkSuggestion`):
- the content script may not contain storage, network, clipboard, timers, `eval`, messaging other than its own, a click,
  submit, focus or blur, `dispatchEvent`, HTML or text writes, attribute, class, dataset or style writes, the console,
  imports or exports;
- its chrome APIs are exactly `i18n.getMessage` and `runtime.sendMessage`; its messages exactly `{type: "sk-af-cand"}`
  and `{type: "sk-af-open"}`; every font it names ends with the generic `system-ui,sans-serif`;
- `__skSugLog` only in the e2e build, in every flavour (the dev build too).
- The gate closed: patch 3's rules, unchanged.

### 13.3 Decisions and deviations, with reasons

| #      | Decision | Why |
| ------ | --- | --- |
| P4b-1  | **New: the held-rendering rule** (frames apart by more than 250 ms, or a view transition: the clock again; a click while held: `stale`) | Found by K3-12. While a page holds its rendering, IntersectionObserver reports nothing, and the screen shows the last picture. A cover drawn in a frame the observer did not look at, then held, would stay on the screen as long as the page likes while the button under it stays "seen". `takeRecords` cannot help: nothing was computed. 250 ms bounds that window as the 100 ms period bounds K3-23's |
| P4b-2  | `blocked()` is asked when it would be drawn, after the worker's answer | The worker still sets its badge ("the badge only", K3-25), and a page that makes its root inert in its own handler of the user's click is caught too (K3-26) |
| P4b-3  | The × has no shadow; the live region is under the pill's row | IntersectionObserver v2 counts Sixkey's own paint over the button as covering it |
| P4b-4  | The guard runs before Vite's resolver | After it, the import already resolved to the module itself, and the gate-closed build failed its own check |
| P4b-5  | `chrome.i18n.getMessage` with literal keys | The catalog check and `budget-split` find Chrome's keys by that literal |
| P4b-6  | `__skSugLog`'s rule in every flavour | A dev build skips the content script's minified-shape checks, and the record's rule is not one of those |
| P4b-7  | Some e2e cases make their attack after it shows: `opacity: 0` on `html` or `body` (K3-2), `visibility: hidden`, a transparent colour and `font-size: 0` on `html` (K3-4, K3-5), `zoom` 0.1 or 0.5 (K3-22) | A page that hides or shrinks its box like this from the start has no box the user can see or click, and none the finder names (its own rule). The attack that matters is the one made once the suggestion is there |
| P4b-8  | The fullscreen and view-transition restarts are kept, though no case can reach them | In Chrome 156 no click reaches the button under a fullscreen element (even with `pointer-events: none` on it and its backdrop) nor during a view transition's update; IntersectionObserver and the frame-gap rule already refuse. Mutants FS and VT survive, stated (§13.5) |
| P4b-9  | The e2e set runs in each language as the browser's own; Simplified Chinese through `AppleLanguages` | The content script's words are `chrome.i18n`'s, the browser's language. On macOS that comes from `AppleLanguages`, not `--lang`; the spec reads the expected words from the extension, so one file serves both |

### 13.4 What a page can do, as built

- **Cover it:** with anything in the top layer over it, opaque, transparent, `opacity: 0` or partial, in the light DOM or
  a closed shadow root, a modal dialog, a fullscreen element or a view transition: never armed, every click refused or
  never delivered (K3-7 to K3-12, K3-14).
- **Cover it just before the click:** in the light DOM, the toggle restarts the clock (K3-13). In a page's own shadow root,
  inside IntersectionObserver's first period (about 100 ms), the click may be accepted: §14's residual, measured
  (K3-23, three runs of 20 per timing, English and Chinese: shown 150 ms before, refused 60 of 60; 50 ms, accepted 20 of 60; 10 ms, accepted 43 of 60). Its worst case is Sixkey's popup asking, with nothing filled.
- **Hold its rendering, then remove the cover:** refused (`stale`, P4b-1), or `hidden` when the observer looked.
- **Move it under the pointer** (its box moved, scrolled, a line inserted, the focus put in another code box): the clock
  again (K3-15, K3-29 to K3-31, K3-34 since 4B-FU4, §13.14).
- **Hide it with its own styles** (opacity, filters, clips, transforms, `visibility`, colours, font size, `display` on
  `body`, a stylesheet on `sixkey-suggest`): drawn as on a clean page, pixel for pixel, and accepted (K3-2 to K3-6, K3-21).
- **Shrink it** (`zoom`): never armed (K3-22). **Fake its words** (`@font-face`): drawn as on a clean page (K3-24).
  **Fake the cursor:** its own pointer over the button (K3-27).
- **Touch it** (attributes, removal, a move, `document.open()`, a new root): ended for the document (K3-1, K3-19, K3-33).
- **Click it itself:** it cannot reach the button (a closed root); `host.click()` and its own events decide nothing
  (K3-17). Its own focus, autofocus and events never show it (K3-20). A press it swallows refuses the click (K3-18).
- **Make a key its click:** the button never has the focus (K3-28).

### 13.5 Tests

**Unit, new:**
- `autofill4b-arm` (17): `readAnswer`'s exact shapes (C2: anything else is no answer); the clock (800 ms, a break, a restart, a
  frame gap of more than 250 ms); full size (0.8 of zoom and of 32 px); `judge`, each reason alone, their order, and the
  keyboard's; `meet` (empty rectangles never meet); `place` (under, over, right to left, inside the viewport).
- `autofill4b-build` (6): the guard's hooks one by one; two real bundles with the gate closed: the content script, built
  with none of the suggestion in it, and an import of the suggestion by another path, which fails the build.
- `autofill1-check-dist`, the gate open: sixteen tampered e2e builds (a third message, one of another shape, storage, a
  timer, `innerHTML`, `textContent`, an attribute, a style, `focus()`, `click()`, `postMessage`, `fetch`, the console, a
  second chrome API, a named family before the generic one, a named family alone), each failing with its own rule; the
  record both ways (in e2e only, the dev build included); the store build's content script holds none of the suggestion.

**Unit, changed on purpose:** `suggest-ui-gate` (`suggest.ts` reads the gate), `autofill-pre-source-rules` (the
suggestion's two messages are content rows), `budget-split` (Chrome's keys `afSugFill`, `afSugNo`), `autofill1-check-dist`
("a second message" in an e2e build meets the two-message rule).

**e2e:**
- `autofill4b-suggest.spec.ts`, 50 cases (`suggest-helpers.ts`): the normal path (P-1: under the box, the host named, idle
  then armed, the popup with R v2; P-2: ×, Esc, a click elsewhere), then K3-1 to K3-33, each the attack a page could make,
  with its variants. Every accepted click checks R v2 for that page and that nothing was filled; every refused one, its
  reason, no R, and the focus. "Drawn as on a clean page" is a pixel comparison of the button, inset from its edge, with a
  clean page's.
- Both languages: English, and Simplified Chinese (P4b-9 below): every case passed in both. Runs of at most 180 s each, in
  22 groups, on a machine whose load average was 300 to 1,000 (other work): a case that failed for the environment was run
  again alone (§13.6).
- `autofill2-content.spec.ts` :110 changed on purpose: with the gate open the page sees Sixkey's own element, with no
  attribute and a closed shadow root, and nothing else.
- Also run: `autofill2-content`, `autofill2-sites`, `autofill4-page`, `autofill1`, `autofill2` (each case with
  `--repeat-each 3`), `quick-pin`, `pin-restart`, `popup-text`, `afmatch`, and `perf.spec.ts` (_whole open 7_, the base's).

**Mutants, 59, each killed by an assertion or stated:**
- e2e (25): each K3 case's defence removed, the e2e build rebuilt, the case run to its first failure: the tamper observers
  (X1, X2), the top layer (T1), the host under `html` (H1), the resets (V1, C5), `isVisible` (I1), the toggle restart (TG),
  the move restart (MV), 800 ms (AR), the closed root (K17a), the press on the button (ND), trusted events (TR), the host's
  `!important` (IM), full size (Z1), `takeRecords` (K1), the held-rendering rule (GP), the generic font (F1), the modal and
  inert rule (M5), the cursor (CU), the focus (FO), one use (U1): **23 killed**. **FS and VT survive**, as P4b-8 states.
- unit (28): every rule of `suggest-arm.ts` and of the guard: all killed.
- check-dist (6): the messages, a timer, the font rule, the record, the APIs, attributes and styles: all killed.

**The gate closed:** a prod build's `inject/suggest.js` is the base's, byte for byte; every other file too, `_locales`
aside (§13.1). Gate-open sizes (gzip, e2e build): `inject/suggest.js` 3,631 of 6,144; the worker, the popup and the side
panel unchanged from 4a (103,171, 59,567, 61,817).

### 13.6 Residuals, stated

- K3-23 as the plan bounds it: a cover in a page's own shadow root shown inside IntersectionObserver's first period. The
  popup opens and asks; nothing is filled.
- The fullscreen and view-transition restarts have no case that reaches them in Chrome 156 (P4b-8).
- Real Chrome checks (4c's checklist items): the suggestion next to password managers' inline menus; on Turbo-style
  sites that replace `<body>`; the input delay after its click.
- The Simplified Chinese run (P4b-9): macOS reads a browser's language from `AppleLanguages`, not from `--lang`, so the
  run starts the browser through a wrapper that sets it: the wrapper is the runner's own (not in the tree), named by
  `SK_CHROME` (`test/e2e/panel-helpers.ts`). The spec reads its expected words from the extension, so it is the same file
  in either language.
- The e2e runs on a loaded machine met two failures that are not this patch's, both noted for their owners:
  - the worker sometimes never answered a `cand` (the suggestion then never shows on that page) while it answered the
    test at once. Once, 4a's `sixkey-af-open` lock was held with nothing waiting, its record write unanswered. Rare,
    with load; the same family as `autofill2.spec.ts:77`'s;
  - `autofill2.spec.ts` (on hosts the content script never runs on) failed now and then for want of a popup, as :77
    does.

### 13.7 Review, and what is left before the flip (4d)

One independent code review: merge after one fix. K3 matches the plan case for case; the gate-closed prod build
was rebuilt by the reviewer and at the merge, `inject/suggest.js` byte for byte the base's and only `_locales` different.

- Done at the merge: MUST-1, `inject/suggest.ts`'s header said patch 3's "nothing drawn, one message, no answer, no
  timer" of every build; it now says that of the gate-closed build, and what the gate-open build adds.
- Before the flip, not before this merge:
  - S-1 (4a's, a follow-up of its own): the `cand` path awaits six browser calls with no deadline, and `noteShown` holds
    `sixkey-af-open` around a storage.session call. One lost response leaves that page without the suggestion, and one
    inside the lock leaves every later page without it for the rest of the worker's life (the badge and the shortcut
    still work; no security effect). The review reads §13.6's sighting as stuck, not slow, the same family as
    `autofill2.spec.ts:77`. Fix: bound each storage call inside the lock, answer `show: true` only after `noteShown`
    succeeded, a deadline on the worker's handler and a non-caching one in the content script.
  - S-2: the frame loop runs for as long as the suggestion is shown, and it never expires: read `direction` once, and
    hide it after about 2 minutes without the user's input (it is shown again at the next look).
  - S-3: measure, on 2–3 real 2FA pages and with the CPU throttled, the time to armed and the share of refused clicks
    (the held-rendering rule and password managers' inline menus can keep it from arming); give a refused `early` or
    `stale` click a visible cue in the pill (warn, do not block); make `accepted()`'s stale retry count its uses.
  - N-1: a unit test each for the fullscreen and view-transition restarts (FS, VT); N-2: a second click in the box
    within 2 s after a click elsewhere does not show it again (the look's throttle runs before the cached answer);
    N-3: `takeRecords`'s K3-23 case to expect `refused:hidden` alone, if it is deterministic.
  - N-4, stated: the content script keeps an answer per page address for the document's life, so a site turned on, or
    Autofill switched on, after the first look shows the suggestion only after the page is loaded again.
- 4c's lines (text and docs): `docs/PRIVACY.md` (the content script "gets no answer", "does not show the code next to the
  box yet"; that the page can see that Sixkey is on for it), `README.md` and `README.zh-CN.md` (one message, no answer),
  `docs/ARCHITECTURE.md` (nothing exposed to pages, one message, no answer; the storage table's `sk_sug_shown` and
  `sk_sug_open`), and `platform/content-channel.ts`'s "the page gets no answer", scoped to the gate closed.

### 13.8 Follow-up 4B-FU: the review's list before the flip (2026-11-02)

Everything here is behind the release gate: a store build is the base's (56e650e) byte for byte, `_locales` aside
(`afSugWait`, +68 and +67 B raw, +24 and +23 B gz).

**S-1, the `cand` path's deadlines.** Three, nested, so that each layer gives up after the one inside it:
- `platform/page-open.ts`: every storage.session call inside `sixkey-af-open` (a read and a write each, in `noteShown`,
  `takeShown` and `takeToken`) is bounded by `STORE_MS`, 5 s. A call whose answer never comes fails its operation, and
  the lock is let go: the next operation goes through. A write that times out may still land later; each such case fails
  safe (a document not noted cannot open; a document marked opened cannot open again; a token spent is a token less).
- `platform/content-page.ts`: `show: true` is answered only once `noteShown` succeeded, and only then is the document
  kept in this worker's memory (the side panel's synchronous open trusts that memory). The whole `cand` is answered
  within `CAND_MS`, 15 s, or not at all: a late result is dropped, `{show: false}` included, which the content script
  would otherwise keep for the page.
- `src/inject/suggest-ui.ts`: the content script waits `ASK_MS`, 20 s, for an answer. After it, the next look asks
  again, and the overdue answer counts as none and is not kept. Timestamps, not a timer (the content script has none).
- **The numbers** (the review suggested about 2, 3 and 5 s): a browser call answers in about a millisecond on an
  idle machine. On this one, at a load average of 600 to 800, single calls took up to 0.6 s, the eight calls of the
  `cand` path several seconds together, and the worker itself once stalled 12 s. With 2, 3 and 5 s, three of the first
  run's e2e cases never showed the suggestion: each `cand` met the worker's deadline, three asks in a row, while every
  call the diagnostic made answered. The deadlines are for a lost answer, not a slow one: 5 s for one storage call (the
  lock is held 10 s at most), 15 s for the path, 20 s for the content script's wait.
- **The nesting holds per operation** (4B-FU2, the review's N-3): one `cand`'s storage calls fit inside its own 15 s. A
  `cand` queued behind other holders of `sixkey-af-open` waits for them first, so its own deadline can come before its
  turn. That is harmless: nothing is answered, nothing is kept, and the content script asks again at its next look.

**S-2, the frame loop's cost.**
- The box's `direction` is read once, when the suggestion shows, not in each frame.
- Shown `IDLE_MS` (two minutes) without the user's own click or key press, it is hidden and its frames stop. The next
  look shows it again from the answer kept (N-2's path), with no new `cand`.
- Measured (`autofill4b-measure.spec.ts`, a page of 5,000 elements more, SK_MEASURE=1): with the suggestion shown, the page's main thread spent 16 ms a second on tasks (6 of them
  script); once it was dismissed, 1 ms. About 1.5 % of a core, for as long as it is shown, hence the two minutes.

**S-3, arming in practice.**
- A click refused as too early (`early`) or on a page that held its rendering (`stale`) changes the button's words to
  "One moment, then click again" (_稍等片刻，再点一次_; `afSugWait`, proposed) for `CUE_MS` (3 s), and the live region says
  the same. Any other refusal changes nothing (covered: there is nothing to read; used: it is gone).
- `accepted()` (the e2e helper) retries a `refused:stale` click once, counts it, and fails a case that needs a second.
  The spec prints the count: 0 in all 25 runs of this patch (the English set and the Chinese subset).
- Measured with DevTools' CPU throttling (`autofill4b-measure.spec.ts`; a person clicking 0.7, 1, 1.5 or 2 s after it
  appeared, then every half second until it opens), at 1×, 4× and 6× alike: armed 814 to 824 ms after it appeared (8 times each);
  of 10 clicks each, the two made at 0.7 s were refused as `early`, and every slower pace opened at the first click; never
  `stale`. The fixture page has no work of its own, so throttling its CPU changed nothing here: what a page's own long
  tasks do is for the owner's checklist below.
- The owner's real-Chrome checklist (4c) gets these, not driven here:
  - on GitHub, Google and a React single-page app's 2FA page: the time from the suggestion appearing to its blue look,
    and whether a click at a normal pace is ever refused ("One moment");
  - with 1Password and Bitwarden installed: whether their inline menu covers the suggestion (it then never turns blue),
    and whether either can be used;
  - the same on a laptop on battery, the tab left open two minutes (the suggestion should go away by itself).

**N-1:** the fullscreen and view-transition restarts each have a unit case in a minimal page
(`test/helpers/suggest-dom.ts`, `autofill4b-dom.test.ts`): their removal (FS, VT, and the transition's restart alone)
is killed by an assertion.

**N-2:** a click back into the box that the finder named before is answered from the kept answer before the 2 s between
looks: shown at once, with no new `cand`.

**N-3:** the `takeRecords` case gave `refused:hidden` in each of its 36 clicks (9 runs: 6 in English, 3 in Chinese), so it
now expects that alone.

**The minimal page** (`test/helpers/suggest-dom.ts`): `suggest-ui.ts`, `suggest-arm.ts` and `suggest-core.ts` run
unchanged in Node, with the clock, the frames, IntersectionObserver's reports and the worker's answers in the test's
hands. Layout is fixed rects, `getComputedStyle` answers `direction` only, and events are the listeners the code
registered, called in the browser's order for the events the helpers make. It proves the code's decisions, not the
browser's (the e2e set does that).

**Tests and mutants:**
- unit, new: `autofill4b-dom` (13), `autofill4bfu-deadlines` (16); changed on purpose: `budget-split` (Chrome's key
  `afSugWait`).
- mutants, 29, all unit: each bound inside the lock (six) and `STORE_MS`; the handler's deadline, the record before
  `show: true`, memory after the record, a late answer, `CAND_MS`; the content script's deadline, a late answer taken,
  `ASK_MS`; the direction per frame, the idle hide, a key press as input, `IDLE_MS`; the cue (none, on every refusal,
  never taken back, kept through a hide), `CUE_MS`; FS, VT, VT's restart alone; N-2. All 29 killed by an assertion.
- e2e: the 4b set with these changes, in English 24 runs and 50 cases: 49 passed, and K3-14 once never showed the
  suggestion (two asks unanswered, at a load average of 650, before the test recorded the worker's calls); rerun twice: 2 of 2.
  In Chinese: P-1, P-2, K3-2, K3-16, K3-24 and K3-28, 9 of 9. `showIt` now clicks again once the answer is overdue
  (`ASK_MS`), and, when the suggestion does not show, prints the worker's calls since the first click: the test's own
  wrappers on the worker's chrome APIs and a listener that answers nothing, no product code.

**Sizes, the gate open** (gzip, e2e build): the worker 103,171 → 103,365 (the deadlines); `inject/suggest.js` 3,631 →
3,864 of 6,144; the popup and the side panel unchanged.

**Not done here, and what it would be:** the shortcut's own storage reads (the `autofill2.spec.ts:77` family) change the
store build, so they get a patch of their own. It would bound the same way the shortcut's first awaits (the lock epoch's
storage.session read, R's write under `sixkey-fill-req` in `putRequest`, and the popup's read of R), so that a lost
answer ends that press with the badge's fallback ("press again") instead of a silent stall, and leaves no lock held.

**What this does not prove:**
- why the browser loses a storage answer (it is Chrome's; the bounds only stop it from lasting);
- the frame loop's cost in battery: measured as main-thread time only;
- the real pages and password managers (the owner's checklist above);
- that the new words are the right ones: `afSugWait` was a proposal, and the maintainers took it (with the 5/15/20 s
  bounds).

**Review (one independent code review): merge, no MUST.** It checked the deadline mechanics (timers cleared on every path,
no unhandled rejection, the lock released when an inner call is lost; a timed-out write that applied after all fails
safe: no `open` without a `show: true` the content script saw, and a forged `open` gains nothing new), that the mini-DOM
runs the real `suggest-ui.ts`, and the gate-closed build (only `afSugWait` in `_locales`). Before the flip (4d):
- S-1 and S-2: a test each for what the code already does, both found by surviving review mutants: only trusted input
  keeps the suggestion from its idle hide (else a page's own events could keep the frame loop running), and a re-show
  on N-2's fast path arms from zero (else a hide and a re-show within 250 ms at a moved place would be at once clickable:
  K3-15 by a new path);
- S-3: the `open` path's remaining unbounded awaits (the lock epoch's read, `putRequest` under `sixkey-fill-req`, which
  every context takes) are the shortcut patch's above; that patch is a precondition of the flip. And a fixture page with
  its own long tasks in `autofill4b-measure.spec.ts`, so that the share of `early` and `stale` refusals and of the cue is
  measured;
- NITs: `untrusted` in the "no cue" test; an RTL page's cue changes the pill's width and with it its left edge, which
  restarts the clock (keep the width); the nesting of the bounds holds per operation (with holders queued on the lock,
  the worker's deadline may come first, which is harmless); the live region keeps "One moment…" after the cue.

### 13.9 Follow-up 4B-FU2: the 4B-FU review's tests, a busy page measured, its NITs (2026-11-02)

Gate-only: a store build is 8ec6795's byte for byte, `_locales` included (no new words).

- **S-1:** only the user's own input keeps the suggestion from its idle hide. A minimal-page case sends the page's own
  `pointerdown` and `keydown` (untrusted) every 30 s for longer than `IDLE_MS`: it hides at two minutes all the same.
  Another sends the user's every 30 s: it stays. The review's R1 (input counted before the trust check) is killed.
- **S-2:** a re-show from the answer kept arms from zero. Shown and armed, a click elsewhere hides it, a click back in
  the box 50 ms later at a moved place shows it again at once: not armed, a click 700 ms after IntersectionObserver sees
  it whole again is `early`, and it arms 800 ms after that report. The review's R4 (`hide()` keeping the clock) is
  killed.
- **N-1:** the "no cue" case has an untrusted click too (`refused:untrusted`, no cue): the review's R2 is killed.
- **N-2:** on a right-to-left page its place is taken from its width with its own words, so the cue's other width
  neither moves it nor restarts its clock (a case on an RTL box, the minimal page's popover as wide as its words).
- **N-3:** §13.8 says the nesting holds per operation.
- **N-4:** the cue's end puts the live region's line back as well.
- **S-3, measured** (`autofill4b-measure.spec.ts`, a fixture page busy with its own work every 700 ms; a person clicking
  0.7, 1, 1.5 or 2 s after it appeared, then every half second, 10 clicks at most; load average 15 to 20):
  - **busy 150 ms** (under `GAP_MS`): armed in 802 to 822 ms; one click refused (`early`, at 0.7 s), every other at once
    opened;
  - **busy 300 ms** (over `GAP_MS`): **never armed**. Each long task stops its frames for more than 250 ms, which
    restarts the 800 ms, and the next one comes 700 ms later. 40 of 40 clicks refused, all `early` (none `stale`), the
    cue on the button after each; at no pace did it open.
  - **A proposal, not taken: `GAP_MS` from 250 to 500 ms.** Tried in a scratch build: the 300 ms page armed in 928 to
    941 ms and none of its clicks was refused, and K3-12 and both K3-23 "held" cases (600 ms, and 130 + 110 ms) still
    passed. What it gives up: a cover drawn in a frame IntersectionObserver did not look at and then held for under
    500 ms would no longer restart the clock, and a click during the hold would be taken: `clicked()` reads the time
    when its handler runs, so a click queued behind the hold is `fresh` when the hold is under `GAP_MS` (the code
    review's probe, a real browser: a 400 ms hold accepted at once with 500, refused 4 of 4 with 250). Its effect would
    be K3-23's (the popup opens asking, nothing filled), but over a window of 500 ms instead of about 100. A page busier
    still (500 ms or more every 800 ms or less) would keep the suggestion from arming either way; the badge and the
    shortcut fill there as always. A short re-arm after a gap instead of the full 800 ms would do little for the 300/700
    page.
  - **Decided (the maintainers, on the code review's advice): `GAP_MS` stays 250.** A 2FA page usually waits idle for
    the code. Whether the suggestion arms on real busy 2FA pages is a real-Chrome check that gates the flip (4c's
    checklist). If real pages fail it, 500 comes back with a K3 case of its own, and the widened residual is stated with
    K3-23's (§13.6). Meanwhile, before the flip: after two refusals in a row the pill shows the shortcut's line (existing
    words), so that on a busy page "One moment, then click again" does not repeat itself.
- **Tests and mutants:** `autofill4b-dom` 13 → 18 cases (and one extended); the 4B-FU mutants (29) and the review's R1,
  R2, R4, and N-2's and N-4's (5): all 34 killed by an assertion. e2e: the 4b set in English, 50 of 50, and the Chinese
  subset (P-1, P-2, K3-2, K3-16, K3-24, K3-28), 9 of 9.
- **Sizes, the gate open** (e2e build): `inject/suggest.js` 3,864 → 3,888 B gz; the worker unchanged.
- **Not proved here:** what real busy pages do (the owner's checklist of §13.8, a check before the flip).

### 13.10 AF-BOUND: the shortcut's path bounded (2026-11-02)

**This changes the store build, on purpose:** a reliability fix of patch 1's shortcut, and a precondition of the flip (the
4B-FU review's S-3; §13.8's "Not done here"). No new words, permissions or messages.

**What is bounded** (`platform/bounded.ts`: `bounded()` and `STORE_MS`, 5 s, first in `page-open.ts` (4B-FU), now shared,
with its reason: a browser call answers in about a millisecond, and at a load average of 600 to 800 single calls took up
to 0.6 s, so one that takes 5 s was lost, not slow):
- **the shortcut** (`background/fill-command.ts runShortcut`): its first await, the lock epoch's storage.session read;
- **R's path** (`platform/fill-request.ts`): `putRequest`'s write under `sixkey-fill-req`; in `takeRequest`, R's read,
  the lock epoch, the tab in front and R's removal; `peekRequest`'s read. R is read through one function,
  `storedRequest`, which the popup's resume (`popup/main/Fill.tsx`) uses too;
- **the gate open only:** the `open`'s lock epoch read (`platform/content-page.ts`), which the review named with these.

`sixkey-fill-req` is taken by the worker, the popup and the side panel: an answer lost inside it held every context's
Fill, and every unlock that fills, for good. Now a lost one fails its operation after 5 s, and the lock goes.

**What the user sees when an answer is lost** (rare, under heavy load): the press ends after about 5 s in the fallback a
press without R always had. The popup (or the panel) opens on the lock screen without the page's line, and the badge
says that Sixkey is locked; after the unlock nothing is filled, and the next press works. Before, nothing happened at
all, for that press and, after a loss inside `putRequest`, for every later one.

**Not bounded** (out of this patch's scope): the vault's own reads in `fillOnTab`, and storage calls that hold no
cross-context lock.

**The store build, against 4B-FU2's** (gzip -9 of each built file; check-dist's own counts in brackets):
- `sw.js`: +257 B raw, +72 B gz (check-dist: 102,771 → 102,851 of 106,496);
- the `fill-request` chunk: +175 B raw, +100 B gz; the Fill chunk: −21 B raw, −22 B gz (its resume's read is
  fill-request's now); the `late` chunk: the same length, only its import of fill-request's renamed exports;
- the popup 58,394 → 58,397 and the side panel 60,625 → 60,627 of their budgets (check-dist);
- every other file: the same bytes, once its chunks' hashed names (renamed because a chunk they import changed) are set
  aside. Same `_locales`, manifest, permissions and messages; check-dist passes for prod, dev and e2e.

**Tests and mutants:**
- unit, new: `afbound` (13): `bounded()` itself; `putRequest`'s write and `takeRequest`'s four calls, each never
  answered, failing at `STORE_MS` with the lock free for the next; `peekRequest`'s read; `runShortcut` with the lock
  epoch never answered (at 5 s: locked, no R, the popup, the badge); the `open`'s epoch (no request, no popup); Fill.tsx
  reading R only through `storedRequest`.
- e2e, new: `afbound.spec.ts`, in a real browser. The worker's next storage call of one kind is made never to answer, in
  the same evaluate that presses the shortcut (a wrapper of the test's own; no product code): the lock epoch's read, and
  R's write under the lock. Each time the popup opened on the lock screen 5 s later with no line and no R, and the next
  press wrote R and the open popup showed its line (no lock held). 2 of 2, twice.
- mutants, 15: each bound (seven), `STORE_MS`, the bound's timer, Fill.tsx's read, page-open's three through the shared
  helper; and two in the real browser, R's write and the lock epoch unbounded, where the press then stalls as
  `autofill2.spec.ts:77`'s did (killed by the spec's assertion). All 15 killed by an assertion.
- run on this patch: `autofill2` whole, 15 of 15, and its :77 five times, 5 of 5; `autofill1` 29 of 32 run and passed
  (three not reached in their 180 s, each waiting for the code's next period at low load, then run alone: 3 of 3);
  `quick-pin` 9, `pin-restart` 13, `perf.spec` (_whole open 7_); full unit (with 4B-FU2), 329 files and 5,302 tests.

**:77's diagnostics:** in these runs (load average about 20) no natural stall came, so they show none turning into
anything. The forced loss above is the same stall (a storage answer that never comes, on the shortcut's first await or
under its lock) and it now ends in the fallback; with the bound removed (eP, eS), it stalls as :77 did.

**What this does not prove:** that the browser's lost answers are only these calls (the vault's own reads and the other
storage calls of a press are not bounded); a loss in a real Chrome (the forced one is the test's); that 5 s suits a
machine slower still.

**Review (one independent code review): merge.** It checked that every caller of the bounded functions takes the failure
into the existing fallback (no unhandled rejection, no surface left waiting), that a timed-out call that landed after all
fills nothing the user did not ask for and nothing twice, and that the lock's longest hold (about 20 s in `takeRequest`,
only when answers are lost, never on `cand`'s path) does not upset 4B-FU's deadlines; it built the store build itself
and found the sizes above, nothing else. Left, both before the flip and both with the gate open only:
- `popup/main/page-fill.ts refresh()` still reads R with a bare `area.get`: a lost answer there leaves that surface
  without the page's offer (no lock held, nothing else affected). Read it through `storedRequest`, and extend the source
  rule on Fill.tsx to page-fill.ts;
- the `open` path has bounded steps but no deadline of its own: when answers are lost, its click can do nothing for up to
  about 25 s (behind a stuck take, then its own write). Acceptable as is; stated here.

### 13.11 Follow-up 4B-FU3: the second refusal points to the shortcut; page-fill's read bounded (2026-11-02)

Gate-only: a store build is dd76e2a's byte for byte (4637825's: dd76e2a changed text only). No new words.

- **The second refusal in a row** (the GAP_MS decision, §13.9: 250 kept, and a cue that escalates). In one showing, the
  first click refused as `early` or `stale` says "One moment, then click again" for `CUE_MS`, as before. The second in a
  row says the shortcut's line instead, the tooltip's own words: _Sixkey can fill the code here: press Alt+Shift+F_
  (`afCanFill`, with the shortcut as set), or _…: open Sixkey_ (`afCanFillOpen`) with none. It stays until the suggestion
  arms, or is hidden; then the row starts again. Another reason in between (covered, untrusted, the open) breaks the row.
  On a page that keeps it from arming (§13.9's busy page), the button then says what works: the shortcut, or the toolbar
  icon with its badge.
  - Measured (the 300/700 ms page, `autofill4b-measure.spec.ts`): of 40 refused clicks, the first of each of the four
    showings said "One moment", the other 36 the shortcut's line.
  - The line may wrap at the right edge. Measured in Chromium (the review's C(2a)): in the button's font the line is up to
    118 px wider than the label in English and 103 px in Chinese (macOS writes the shortcut `⌥⇧F`: 4 to 79 px). Near the
    right edge it wraps to two lines (277 × 46 px for one about 100 px wider) and does not overflow; `place()` takes the
    live height, so a wrap that needs it higher moves it, which restarts the clock once. No bound on its width is needed.
- **r2, the review of 4B-FU3:**
  - C-M1: the line ends whenever it arms (`if (armed)` in `frame()`), also after a refusal for another reason between
    (early, early, covered, then armed: before, the armed button kept saying the line until it hid). The review's probe
    is two tests.
  - C-N2, the maintainers' decision: no wider in the frame it arms. While any cue is up (the moment, or the line), the
    suggestion is held at least at the width it has with its own words: `cue()` writes `#p{min-width}` and
    `#b{flex-grow:1}` to a sheet of its own, and `uncue()` empties it in the same task as the words come back. So their
    return keeps or shrinks it, in the arming frame or later, and never widens it into an area not seen for 800 ms. Not
    chosen: restarting the clock at every uncue (a busy page pays another 800 ms), and keeping the line on an armed
    button (its words do not describe the click). The hold is not part of its place, so it restarts nothing.
  - Left as it was since 4B-FU (S-3): a cue wider than its own words (the line on most hosts, the moment on short ones)
    widens it when it appears. That area arms when the clock already running ends, not after 800 ms of its own: after an
    `early` refusal, nothing is clickable before then; after a `stale` one, at the next drawn frame. Closing it would
    restart the clock whenever a cue widens it, that is, at most second refusals.
  - C-N1, C-N3: the stale comment on `cue()`, and the test that matched page-fill's source by a pattern, are gone; the
    naming rule and the hang test stay.
  - The revised mini-DOM cases cover the intervening refusal and the width hold. The final combined revision
    (with 4B-FU4) passes 133 related unit cases in 11 files; its browser and mutation results are recorded in §13.14.
- **B-S1:** `popup/main/page-fill.ts refresh()` reads R through `storedRequest`, so a lost answer drops the binding after
  5 s instead of holding `offer()`. The source rule now covers all of `src/`: no file but `platform/fill-request.ts`
  names R's key, and every reader it exports is bounded.
- **Initial revision’s tests and mutants:** `autofill4b-dom` 18 → 23 cases (the row: two refusals, kept past `CUE_MS` until it arms, a new
  row after it arms and after a hide, another reason breaking it, no shortcut set); `autofill4bfu3` (2 since r2:
  `refresh()` against storage that never answers; the naming rule). 41 mutants (4B-FU2's 34, the row's six, page-fill's raw
  read): all killed by an assertion. e2e: P-1, P-2, K3-13 to K3-16 and K3-28 to K3-32 in English, 11 of 11; P-1, K3-16
  and K3-28 in Chinese, 3 of 3.
- **Initial revision’s sizes, the gate open** (e2e build): `inject/suggest.js` 3,888 → 3,928 B gz; the worker unchanged.

### 13.12 Patch 4c: the docs and the owner's checklist (2026-11-02)

Text only: no code, no build changes. Every user-facing promise stays true for the store build now, whose release gate
is closed until 4d (§13.13).

- **`docs/ARCHITECTURE.md`**, which can describe both builds:
  - §3: `sk_sug_shown` and `sk_sug_open` in storage.session, "only in a build with its release gate open";
  - §4, web pages: "in the store build, nothing exposed to pages", the content script as the store build has it
    (unchanged), then the gate open: `cand` answered, the suggestion drawn in a closed shadow root that the page can
    see, `open` and its K3 rules, the popup's confirmation; the deadlines of 4B-FU; and the Fill shortcut's bounds of
    AF-BOUND, in every build;
  - §7: a row for the gate in each build flavour.
- **`ROADMAP.md`:** "being designed" (twice) is now "built, off in the store build", with the real-Chrome checks named.
- **`docs/OWNER-CHECKLIST.md`**, items 52 to 58 (in Chinese, as the rest), each with its steps, the expected result and
  the result that blocks the flip:
  - 52: real 2FA pages (GitHub, Google, Microsoft, AWS, a React app), busy ones included: does it arm, how long to the
    blue look, how often "One moment" and the shortcut's line show; the two-minute hide on battery;
  - 53: the popup's input delay after the click (unlocked, and the PIN at a normal and a fast pace);
  - 54: side panel mode, also with the worker asleep (40 s);
  - 55: next to 1Password's and Bitwarden's inline menus;
  - 56: Turbo-style sites that swap the page without a reload (GitHub);
  - 57: the Chinese UI's words;
  - 58: the shortcut's fallback after a lost answer (AF-BOUND), in the store build, if it can be met at all.
  Items 52 to 57 use the dev build (`npm run build:dev`), whose gate is open.
- **Unchanged here, on purpose:** `docs/PRIVACY.md` 220–229, `README.md` and `README.zh-CN.md`'s promise rows,
  `docs/security/local-vault.md`, the checklist's item 25: all true of the store build now, and changed by the flip.
- **No changelog:** the tree has no CHANGELOG or release-notes file (`docs/RELEASING-THE-TREE.md` is about making the
  public tree), so AF-BOUND's store change is recorded in §13.10 and its commit only.
- **r2, the review of 4c** (on 4B-FU4, so that the open gate's claims hold):
  - Item 52 (D-S1): sites are turned on from the fill card, after a fill there ("Suggest codes automatically on <site>?");
    Settings only lists them. The dev build is another extension with its own empty vault, so the accounts go into it
    first (from a backup, for example).
  - D-S2: Chrome on macOS shows the shortcut as `⌥⇧F` (Windows: Alt+Shift+F), in items 52, 57 and 58, and in item 25's
    older tooltip line.
  - Item 53 (D-S3): after a fast PIN, Enter is taken only after half a second without a key (the Unlock button turns
    blue): an Enter at once does nothing, on purpose, and is not a blocking result.
  - Item 56 (D-S4): clicked or dismissed once in a document, the suggestion does not come back there until a reload, and
    a Turbo page swap is not one. Said in the expected result, and the steps keep the click for last.
  - Item 52 (D-S5): ten tries per site, each after a reload; more than 2 of 10 with "One moment" at a normal pace, on any
    one site, blocks. D-N1: "每帧", not "每秒". D-N2: ARCHITECTURE says "above it when there is no room".
  - ARCHITECTURE describes the 800 ms visibility clock and links its limits: every showing, at another box too, waits
    for IntersectionObserver's first report at its place after 4B-FU4 (§13.14). The two residuals stay as they are:
    the click inside the first report's period after a page's own shadow-root cover (§13.4, K3-23), and a cue that
    widens it (§13.11). This is not a guarantee that every part of the button was visible for 800 ms.

### 13.14 Follow-up 4B-FU4: another code box while it is shown (the review's P-M1) (2026-11-02)

Gate-only: a store build is dd76e2a's byte for byte. No new words.

- **The defect, in 4b's own `show()` (since 56e650e):** it returned early only for the same box. For another box while
  shown it kept everything: the arming (its clock), the row of refusals and the cue's words; it set `at = ""`, so its
  first frame there skipped the move's restart; and its `frame()` started a second frame loop.
  - A key in a second code box (a page can put the focus there with `B.focus()` while the user types in the first): the
    suggestion jumped to it still armed, and a click 226 ms after the jump was accepted (the review, real Chromium). That
    is the "moved under the pointer" case the restart exists for, so K3 did not hold.
  - A click into the second box hides and shows in one task. Nothing changed for IntersectionObserver in between, so it
    reported nothing, and the hide's `seen(false)` stood: never armed there (it failed closed, but dead).
  - Each switch left one more `requestAnimationFrame` chain.
- **The fix (the review's `fix-show-switch.patch`, applied):** every showing is a new one. `show()` resets the row and the
  cue's words (`inRow = 0`, `uncue()`) and the clock (`arm.seen(false)`), before `showPopover()`; then it observes the
  button afresh (`unobserve`, `observe`: the same target observed again would get no first report), so the clock runs
  from IntersectionObserver's own first report at the new place. The frame loop carries a generation: each showing
  starts its own, and an older one stops at its next frame.
- **Tests:**
  - Unit, in the mini-DOM, whose IntersectionObserver now behaves as Chrome's (observing a target it observes already does
    nothing; `report()` delivers only a change or a first report; a second code box): a key in box B while armed under A
    (moved, not armed, a click at once refused `hidden`, then `early` until 800 ms after the first report at B); a click
    into B (reported afresh, arms, opens); five switches by key and by click leave one frame loop; a switch with the
    shortcut's line up gives back its own words, without the hold, and a row of its own.
  - e2e, in the e2e build: K3-34 (`/otcs?n=2`, the second box 260 px lower: a key in it while armed; the click as soon as
    it is seen there is refused `early`; then armed after its own 800 ms, and accepted) and P-3 (a click into the second
    box: it arms there, and is accepted). The e2e build's record gains `seen()` (IntersectionObserver's report, for
    K3-34's timing).
  - Verification on the combined C2 + 4B-FU4 tree: 11 related unit files, 133 cases; 56 of 56 real-Chromium K3/positive cases, including K3-34, P-3 and four actual-button geometry checks (LTR/RTL, centre/right edge). All 13 selected review mutants were killed by assertions, without timeout or load error; `accepted()` made zero stale retries.
- **Sizes, the gate open** (e2e build): `inject/suggest.js` 4,030 B gz, under its 6,144 B limit; the worker is 103,334 B gz, under 106,496 B.
