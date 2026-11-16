# Plugin platform, wave 2a: P1 (reading the account list) and the account menu's slot

The owner said "做第二期" (2026-10-26): wave 2 of the plugin platform (MOD-PLATFORM §7.1, row W2), in two reviewed
patches. This is the first, W2a: the prerequisites (the plugin catalog split for the budgets, and the three W2 must-fixes
wave 1 left), P1 (`accounts.read`, SDK §6.3) and its slot `account.actions` (§7.1, V-4). W2b follows with P2 (`add`,
`update`, `trash`) behind Sixkey's change list and the interaction window, the import sample, and the SDK guide. The
owner's preset is OWNER-DECISIONS/16's "balanced": P1 and P2 for reviewed (listed) plugins only, P1 "启用时同意，单独标出"
(agreed at enable, marked separately), plugins added by their ID P0 only, no codes for third parties in version 1, the
Never list reachable by no plugin. The normative text is the SDK spec, now revision 1.0-draft.10 (§6 lists every change:
where it and the code differed, the code won). §12 is the third round, after the review of the second. §11 is the second round, after the independent review
(`scratchpad/w2a/REVIEW.md`, "修改后通过"): it changed when P1 counts Sixkey as open, how a write
meets a key change still being finished, and a few smaller things, each listed there with its test.

W2a writes nothing to the vault.

## 1. What the user sees

- **The approval screen** of a reviewed plugin that asks for P1 lists it apart, under **Sensitive** / **敏感权限**:
  _See your account names (often your email address), their groups and their sites, while Sixkey's popup or side panel
  is open. Not their keys or codes_,
  the plugin's reason quoted, and _Sixkey cannot stop a plugin from sending what it reads to the internet._ (Appendix
  B's drafts). One screen, all or nothing, as before; no other confirmation follows for P1.
- **Settings › Plugins** marks that plugin's row the same way (_Sensitive · See your account names …_), reusing those
  words.
- **An account's own menu**, the edit sheet the row's ⋯ opens in the popup and the side panel, shows the plugin's buttons
  under **Plugins**, each with _Provided by <plugin> · Third-party · reviewed_, only on the accounts the entry's `when`
  names. They ignore a click for 600 ms after they appear (and after the window gains the focus, and after _More
  plugins…_ shows the rest), and they are hidden
  while the sheet's Delete is armed. A click tells the plugin that account (its handle; with `with: ["account"]` its
  summary) and nothing else.
- **Nothing else changes** for the user: no new window, no new prompt, no new permission. A plugin added by its ID
  cannot ask for P1 (Sixkey answers it `developer-mode`, and there is no developer mode). Seconds after the encryption
  key is replaced, an Allow or a switch in Settings › Plugins may wait a moment, and at worst says _Sixkey is still
  finishing a change. Try again in a moment._ (§11, W2A-01).

## 2. Budgets first: the plugin catalog split

Measured before any UI was written (`tools/split-measure.py` in the snapshot folder, on the base tree's catalogs): P1's approval words
add about 100 B gzip to "a vault's page with every lazy catalog in" (15,045 of 15,360 by messages.py's measure, 15,048 by
check-dist's), so P1 alone would have fitted; W2b's change list would not. So the split came first, as the brief asked.

- **Two catalogs, by kind of page.** `catalogs/plugins-<lang>.json` is the settings page's (Settings › Plugins, the
  approval screen, the autofill switch: `src/ui/plugins/text.ts`); `catalogs/plugins-popup-<lang>.json` is the popup's and
  the side panel's (the Plugins button and its menu, _From plugins_, an account's menu, the quiet line:
  `src/ui/plugins/popup-text.ts`). The words every page's entries draw (the heading, _Provided by_, the three badges,
  _Developer copy_, _More plugins…_, _did not answer_, _could not check_) are one table, `PLUGINS_SHARED`, put in both
  (`scripts/messages.py`, `scripts/i18n/plugins.py`). `src/ui/plugins/Entries.tsx` takes its words from the page that draws
  it (a `words` prop), so it loads neither.
- **Enforced.** check-dist holds each page to its own: the popup and the side panel reach `plugins-popup-locale-*` and
  never `plugins-locale-*`, the settings page the reverse (a page that can load the other kind's fails), each exactly its
  generated file, within its budget, with keys of no full catalog and the same keys in every language. A source rule
  pins which modules import which text module (`plugins-w2a-source-rules.test.ts`).
- **What the check counts, flagged for the reviewer.** The limit is unchanged (15,360 B), and so is its list
  (messages.py `PLUGINS_VIEW = DEVICE_VIEW + ["plugins"]`): what changed is what `plugins` holds. The popup's words
  (_From plugins_ and the quiet line, about 40 B of the sum) left it, because no settings page can load them; check-dist now proves
  that by reachability, so "a vault's page" counts what a real vault page can load. The popup's catalog is counted in no
  page's up-front budget, as before.
- **A new budget for the new catalog**, by the rule every catalog follows (its measured size, 396 B zh_CN, plus at least
  1.5 KB, rounded up to 512 B): 2,048 B (messages.py `BUDGETS["plugins-popup"]`, check-dist `PLUGINS_POPUP_CATALOG_GZ`,
  held equal by `budget-split.test.ts`). No existing limit was raised; `plugins` keeps 3,072.

**The numbers** (gzip bytes, check-dist; zh_CN where it is the larger):

| What | Base (live e21c7f4) | W2a | Limit / allowance |
| --- | --- | --- | --- |
| Popup, gate open (store build with the sync interface) | 59,259 | 59,318 (+59) | +500 allowed (≤ 59,759); 2,122 left of 61,440 (floor 1,500) |
| Popup, gate closed (today's store build) | 58,006 | 58,069 (+63) | 61,440 |
| Side panel, gate open / closed | 61,486 / 60,234 | 61,543 / 60,301 (+57 / +67) | 63,488 |
| Settings, every part together (zh_CN) | 12,123 | 12,123 (0) | 12,288 (165 left) |
| A vault's page with every lazy catalog in (zh_CN; en 13,389 → 13,441) | 15,048 | 15,108 (+60) | 15,360 (252 left) |
| Plugins text, the settings page's (zh_CN; en 1,400 → 1,463) | 1,730 | 1,805 (+75: P1's three keys, less the popup's words) | 3,072 |
| Plugins text, the popup's and the side panel's (zh_CN; en 319) | (in the above) | 396 (new) | 2,048 (new, by the rule) |

The popup's few bytes are Main's glue (the edit sheet's `extra`, gated on the platform's chunk) and `grantKeys()`'s
active-key check (N2, below). The lesson of W1a held again: the first N2 attempt imported `core/sync/local/records.ts`
into the lazy platform chunk and cost the closed popup +700 B (the bundler regrouped the module out of the main chunk);
reading the active key through the service (`VaultStore.activeVkId()`, handed out with the key) costs about 30.

## 3. P1: `accounts.read` as built

| Piece | Where | What |
| --- | --- | --- |
| The data | `src/core/plugins/accounts.ts` (pure) | K_h, handles, a summary field by field, the list |
| The order of checks | `src/core/plugins/protocol.ts` `accountsList`, `reach`, `p1Held` | steps 6 to 8 of §10.6 for `accounts.list`; `hello`'s P1 |
| The worker's side | `src/platform/plugins/accounts.ts` `surfaceOpen`, `p1For`; `worker.ts`; `background/sw.ts` | Sixkey's popup or side panel open; the verified record, then the vault, read with the session's key |
| The approval | `src/options/PluginApproval.tsx` `SENSITIVE`; `Plugins.tsx` | P1 apart, the internet line; the row's mark |
| The text | `scripts/i18n/w2a.py` | four keys, settings catalog |

- **Who gets the list.** Only a plugin that passes every earlier step: a context of its own (worker or page; a content
  script is `sender`), approved now (`not-approved`, `disabled`, `suspended`, `blocked`), not unlisted (`developer-mode`:
  no build has a developer mode), a strict empty body (`invalid`; a lone surrogate anywhere too), `accounts.read` in its
  stored grant within its level's ceiling (`not-granted`), within the rate (10 a minute; `rate`).
- **When (step 6).** Only while Sixkey's toolbar popup or its side panel is open (live contexts: `runtime.getContexts`
  with `POPUP` and `SIDE_PANEL`, each at its own page, no permission) and the worker's session holds the vault key. A
  Sixkey page in a tab or a window never counts, the settings page included: any extension can open one (§11, W2A-02;
  round 1 counted `TAB` too). A plugin that is not official is asked about the surface first, so with none open no key
  is looked at; closed and locked are the same `unavailable`, byte for byte (a test compares them; their timing may
  differ by about 1 ms). An official plugin would be told `locked` while locked (§10.6's table; there is no external
  official plugin).
- **The tag (step 7).** The worker verifies the grant store with the session's key (merging a pending overlay, with a
  fresh key if a key change retired the first); the plugin's entry in the verified record must be approved now (the
  catalog's pin and the pauses included) and hold `accounts.read` within its ceiling, else `not-granted`. A storage
  writer's unverified "approved" grants nothing. This comes before the vault is opened (§11, W2A-07 b), and `hello`'s
  `granted` follows it whenever the list would reach it (W2A-09).
- **What (step 8).** For each live account (not in the trash, not erased), built field by field: `handle`, `issuer`,
  `label`, `type`, `digits`, `period`, `group` (`null` for none), `sites` (its registered sites that are host names, at
  most 16). Never the secret, the `otpauth` URI, a code, the algorithm, the counter, the order, the vault's IDs or a time.
  Ordered by handle, so the list shows neither the user's order nor when an account was added. Text from the vault is
  made well-formed (a lone surrogate becomes U+FFFD) and cut to the schema's lengths. Once the list is assembled, the
  surface and the key are asked again before the answer (W2A-07 a).
- **Handles** are §6.3's: the first 10 bytes of `HMAC-SHA256(K_h, pluginId ‖ 0x00 ‖ entryId)` in lowercase base32,
  per plugin, opaque, the same across renames. **K_h is derived**, `HKDF-SHA256(vault key, salt empty,
  "sixkey/v1/plugin-handles", 32)`, rather than the draft's random key in `storage.local` (a deviation, §6): the same
  properties (opaque, per vault, never exported) with nothing to write, lock, bind to a vault ID or read at a popup's
  open. Its one difference: handles also change at a key change. A unit test works a handle out with Node's own HKDF and
  HMAC and a base32 of its own.
- **Revocation at once.** Every request reads the store afresh (the worker), and P1 verifies it every time; a surface
  port answers each message by the store as it is then (`grants.ts narrowedBy`: what the page verified when it opened
  the port, narrowed, never widened, by the current record), so turning a plugin off or removing it counts on a port
  already open; an account entry's click is checked again in the click (§4).
- **The log** (§10.10): `accounts.list` with its outcome, `slot.invoked` for a click; never a handle, a name or a site.
  The interaction window keeps a SHA-256 of the clicked account's handle (§4), never the handle.
- **Residual, stated (SDK §6.3, §13):** in "lock every time" mode the vault key is only in the open page's memory, so the
  worker sees Sixkey locked and the list is always `unavailable`; a plugin that sees its own entry clicked and then gets
  `unavailable` can infer that mode. Closing it needs §3.3 item 6's responder (a page's own listener with
  `sk_plugin_responder`, two race tests), which W2a does not build. Kept so: OWNER-DECISIONS/19 Q2 (a), decided
  2026-10-30 as recommended (§7).
- **What P1 costs at a popup's open: nothing.** The account slot is drawn from the platform's chunk, which the popup loads
  only with the page hint, as in W1a; Main reads nothing new (`perf.spec`'s six reads, a source rule).

## 4. The account slot, `account.actions`

- **Where.** The popup's row has no separate ⋯ menu: its ⋯ opens the account's edit sheet, which is the account's menu.
  Main passes `plugMod.AccountActions` as the sheet's `extra` (as Add's `AddSources`), once, only in the unlocked list's
  view; the sheet draws it only while its Delete is not armed. So it never appears on the lock, PIN, password, confirm,
  export or secret screens (the sheet shows no secret; source rules hold all of this).
- **Who.** Official and listed plugins (`slotAllowed`), holding `accounts.read` now within their ceiling
  (`entriesFor`, from the verified record only); never an unlisted one. Wave 1's rendering rules: plain text, the
  protected terms, at most 2 per plugin and 8 per slot, _Provided by <plugin> · <badge>_, never Sixkey's accent. Each
  entry only on the accounts its `when` names (`accountTypes`; `thisSite`: the account is in the list's "This site"
  section).
- **The input delay.** `Entries` takes `delayed` for this slot: the approval screen's 600 ms (`ui/plugins/delay.ts`, moved
  there from `PluginApproval.tsx`): after the entries appear, after the window gains the focus or the page is shown
  again, after _More plugins…_ shows the rest (`rearm`, §11, W2A-03), and a press, pointer or key, begun inside the delay
  does not count. The P0 slots keep wave 1's click.
- **The click** (`platform/plugins/invoke.ts invokeOnAccount`) re-reads the grant store verified with the key held then,
  redraws the entry by the same rules on that record (`entriesFor`) and checks `when` on this account; turned off,
  removed, P1 taken away, the tag failing or Sixkey locked since the menu was drawn: nothing is sent. Only then is the
  handle worked out, and `slot.invoked` carries `account: {handle}` and, with `with: ["account"]`, `summary` (the same
  summary as the list's). A P0 slot's body never carries an account, whatever is passed (`invokedBody`).
- **The interaction window** is bound to the slot, as in wave 1, and now to the account: `openWindow` keeps a SHA-256 of
  the clicked handle, and `spendWindow(id, "account", now, handle)` opens nothing for another account or for a window
  opened without one. No W2a request spends it; W2b's change lists will.
- **An entry that asks for a code** (`with: ["code"]`) is dropped at `hello` and listed in `unavailable`, since this
  version offers no `codes.read` (§4.3 item 3); drawing it would promise _Gives this code to …_ and break it.

## 5. The W2 must-fixes wave 1 left

- **N5 (PLUGINS-W1A-NOTES §11): the version compared as a version.** Picked: normalise (simpler for plugin authors, and
  correct, since Chrome compares version strings numerically). `normalVersion` (parts as numbers, trailing zeros
  dropped) and `sameVersion` in `core/plugins/descriptor.ts`, used where the descriptor's version meets the manifest's:
  `stateOf`'s version-changed check, `onlyHarmless` when the version is not harmless (with `management`, beyond P0), and
  `versioned()`'s recording. `1.0`, `1.0.0` and `01.0` are one version; `1.0.1` is another. SDK §4.1 now says the
  descriptor's version MUST be the manifest's, as a version, and §4.2 says how it is compared. A real mismatch still
  suspends a P1 plugin (its own bug), and is said in Settings › Plugins as a change.
- **N2 residual: a tagged write never under a retired key.** `GrantStore.write` checks, inside the vault lock it holds,
  that the key it was given is still the vault's active one: `GrantKeys.activeVkId`, which `ServiceCore.grantKeys()` hands
  out with the key (`VaultStore.activeVkId()`: the pointer and its slot read without a lock, for a caller that holds
  it). A write that raced a key change, between the page's `grantKeys()` and the write, throws `StaleKeyError` and
  writes nothing; `withFreshKeys` asks for the key once more and writes again (Settings' approve, switch and remove, the
  autofill switch, the gate's verified read and `touchSwitch`, the views' reads, P1's read). A test over a real runtime
  approves, rotates the key, writes with the old key (refused, the record untouched) and retries (both plugins in a
  record that verifies); another holds the lock while a key change lands, so the check is seen to be inside it.
  **Corrected after the review: round 1 called N2 closed, and it was not.** The retry gets the new key from the
  session, which `committed()` fills before the change's clean-up re-tags the record; a write in that window found the
  record under the old key, took it for a failed one and started a new record with the one plugin it approved, so the
  others went to review (the review's W2A-01, RU-1, RU-5; worse than the base there). Round 2 closes it as §11 says: such
  a write writes nothing and tries again a bounded number of times. `committed()` and `finishUnlock()` keep their order.
- **The well-formedness item (W1c §12.2).** F-1's refusal at step 3 covers the whole message of every request type, so no
  plugin string reaches a P1 or P2 path unchecked: a test sends a lone surrogate in the body of every request type of
  version 1, for a plugin that holds everything, and each is `invalid` before its body is read. P1 itself stores no
  plugin string. Sixkey's own messages are made well-formed too (§3).

## 6. Changes to the specification (code wins)

Every change, in `docs/sdk/SIXKEY-PLUGIN-SDK.md` (revision 1.0-draft.10):

| § | Was | Now (and why) |
| --- | --- | --- |
| header, table | 1.0-draft.9 | 1.0-draft.10, wave 2a, pointing here |
| 2.3 item 1 | (Sixkey's messages not mentioned) | Sixkey's own messages are well-formed: vault text has lone surrogates replaced by U+FFFD; step 3's refusal covers every request type |
| 3.3 item 6 | (no P1) | W2a: no surface registers a listener; in "lock every time" mode `accounts.list` is `unavailable` (the residual) |
| 4.1 `version` | SHOULD equal the manifest's | MUST equal it, as a version (`1.0` is `1.0.0`); with `management` a plugin beyond P0 whose two differ is suspended (N5) |
| 4.2 item 2 | (versions compared as written) | compared as versions, never as spellings (N5) |
| 6.2 registry | `accounts.read` wave W2 | W2a |
| 6.3 handles | K_h a random 256-bit key in `storage.local` | K_h = HKDF(vault key, "sixkey/v1/plugin-handles"), never stored; handles also change at a key change |
| 6.3 accounts.read | (the what, not the how) | as built: who, "Sixkey open" (round 2: its toolbar popup or side panel, `POPUP` and `SIDE_PANEL` only; never a page in a tab), the worker answers, the order (the grant before the vault, the surface and the key asked again), the summaries (live only, by handle, `group` null, sites host names, text well-formed), the "lock every time" residual, the 1 ms timing |
| 6.4 item 1 (a) | a card or change list for that account | the window keeps a SHA-256 of the clicked account's handle (never the handle); another account opens nothing |
| 5.2 | `granted`: the stored grants | round 2: P1 as the verified record holds it whenever `accounts.list` would reach its tag (W2A-09) |
| 6.6 item 6 | (N2 a known residual, PLUGINS-W1A-NOTES) | a write checks the active key inside the vault lock, refused and retried with a fresh key; round 2: and waits while the change's clean-up has yet to re-tag the record, bounded, then asks the user to try again (W2A-01; round 1's "can no longer leave a record that fails its tag" corrected) |
| 7.1 | W1a: `account.actions` arrives with W2 | W2a offers it: official and listed P1 plugins, in the account's edit sheet; `account.primary` stays the built-in's; `action.menu` not offered |
| 7.2 `with` | needs `codes.read` | an entry whose `with` names what this Sixkey does not offer is dropped (W2a: `code`) |
| 7.3 item 9 | (none) | an account slot's entries: the 600 ms input delay, `when` per account, not beside an armed delete |
| 7.4 | (none) | W2a: the click checked again on the record verified then; the handle worked out only then |
| 8.3 P1 row | developer mode only | (W2a: no build has one) |
| 9.3 item 2 | P1–P3 under _Sensitive_ | W2a: P1 apart under _Sensitive_ with item 4's line; the row marked the same way |
| 10.6 | (the table only) | W2a: the surface asked first for a plugin that is not official; step 7 on the verified entry, approved now, holding it; round 2: Sixkey's popup or side panel, the vault after the tag, the 1 ms timing |
| 10.10 | (no P1) | `accounts.list` logged by type and outcome; a click as `slot.invoked`; no handle, name or site |
| 11.1 | `OFFERED_W1`; client without accounts; the fake of wave 1, "no fixture accounts" | `OFFERED`; `accounts()`; the client's `account` check; the fake's P1 (accounts, `openSurface`, `closeSurface`, `lock`, `unlock`, `failTag`, an account's click); the P1 cross-checks; not modelled: Sixkey's handles, `when` |
| 11.2 | the import plugin with W2 | with W2b |
| 11.3 | (none) | the reader test plugin and `plugins-w2a.spec.ts` |
| 13 | (errors' residual) | plus the "lock every time" inference |
| 14 | (P1's approval text) | what P1 hands over |
| 16.1 | a P1 plugin gets `unavailable`, never `locked` | plus: the same bytes closed as locked (round 2: a page in a tab counts as closed); a P1 grant counts only from the verified entry, approved now; `hello`'s P1 never disagrees with `accounts.list` |

Appendix A is unchanged: `accountSummary` and `slotInvoked` were already right (`contract/plugin-sdk/1/` is still
Appendix A verbatim). Appendix B's P1 line was too in round 1; round 2 changed it with the approval text (when Sixkey
counts as open, and the groups: §11). The SDK package follows: `OFFERED` is its default offer
(`OFFERED_W1` kept), `checkDescriptor` drops a `with` it cannot honour, `types.ts` has `AccountSummary` and
`SlotInvoked.account`, the client has `accounts()` and refuses an `account` on a slot without one, a malformed handle
or summary, or a summary of another handle; `fakeSixkey` answers `accounts.list` as Sixkey does and clicks an account's
entry with its handle. Its README says so. `docs/sdk/GETTING-STARTED.md` is unchanged (W2b's).

## 7. Deviations and decisions, with reasons; owner items

- **Decided here, conservative and low-friction:**
  - K_h derived, not stored (§3).
  - The account slot is drawn in the edit sheet (the row's ⋯), since the popup has no other account menu.
  - P1 needs no confirmation beyond the approval (decision 16's "启用时同意"); the input delay is the only friction.
  - The delay applies to account entries only: wave 1's P0 entries hand over nothing, and making them wait would change
    a shipped interaction for no gain.
  - No developer mode: an unlisted plugin's P1 request is `developer-mode`, as in wave 1 (decision 16: "按 ID 添加的插件只能
    放按钮"; the store build's developer switch "第一波之后再定" was not decided then. Decided 2026-10-30, as
    recommended, OWNER-DECISIONS/19 Q1 (a): no switch in any build; a developer tries P1 and P2 in the developer
    build, with the plugin on that build's own list. Implemented: `DEVREAD-NOTES.md`, SDK §11.5).
  - "Lock every time": `unavailable` (§3's residual), not the responder.
  - A port answers by the store as it is at each message (§3).
  - Settings' refused-term notice now looks at the account slot too.
- **For the owner** (none blocks the merge; defaults as built):
  - **The wording**, drafts to approve with the store copy (OWNER-DECISIONS/06) and the data-transfer wording (14 OQ3):
    _Sensitive_ / _敏感权限_; _See your account names (often your email address), their groups and their sites, while
    Sixkey's popup or side panel is open. Not their keys or codes_ / _在 Sixkey 的弹窗或侧边栏打开时，查看你的账户名称（常常是你的
    邮箱地址）、分组和网站；不包括密钥和验证码_ (round 2: when Sixkey counts as open, and the groups); _Sixkey cannot stop a
    plugin from sending what it reads to the internet._ / _Sixkey 无法阻止插件把它读到的内容发送到网上。_; _Sixkey is still
    finishing a change. Try again in a moment._ / _Sixkey 还在完成上一项更改，请稍后重试。_ (round 2); and PRIVACY.md's
    paragraph on what P1 hands over (the store's data form will need the same).
  - **A developer mode** for plugins added by ID (P1 behind a warning, Appendix B's draft): not built. **Decided
    2026-10-30** (OWNER-DECISIONS/19 Q1 (a), as recommended): none in the store build; the developer build's own list
    instead. Implemented (`DEVREAD-NOTES.md`, SDK §11.5).
  - **"Lock every time" and P1**: build the responder of §3.3 item 6 (a page's own listener), or keep `unavailable`.
    Decided (OWNER-DECISIONS/19 Q2 (a), 2026-10-30, as recommended): keep `unavailable`; in that mode P2's proposals
    (wave 2b) end `timeout` too.
  - **OWNER-CHECKLIST 45 and 46**: the approval screen and the developer-copy rule in real Chrome (an unpacked listed
    plugin is a developer copy once Sixkey holds `management`, so it gets no P1: the real P1 path can only be run in the
    e2e build, whose test answer stands in for Chrome's prompt), and a read of what the e2e checks.

## 8. Tests and mutants

**Unit, new** (65 tests):

| File | Tests | What |
| --- | --- | --- |
| `plugins-w2a.test.ts` | 35 | `accounts.list` in the order of checks (every refusal and in which order, the surface asked before the vault, closed and locked the same bytes, the official `locked`, the tag, the verified entry's state, grant, pin and owner, the pause, P0-only and the ceiling, unlisted on a message and a port, the sender, the body, a lone surrogate, the rate, env.get and hello unaffected, hello's grant and `unavailable`); the summaries (eight fields, nothing else, well-formed and cut, the sites, live only, ordered by handle with a precondition that the user's order differs); the handles (worked out apart with Node's HKDF and HMAC; per plugin, across renames, per vault key); the account slot (who draws it, `when`, what a click carries); the window bound to a hash of the handle; what is offered (`with: ["code"]` dropped); N5 (`normalVersion`, `stateOf`, `onlyHarmless`, `versioned`); N2 (a stale key writes nothing, the check inside the lock, `withFreshKeys`); `narrowedBy`; a lone surrogate in every request type |
| `plugins-w2a-platform.test.ts` | 8 | over a fake `chrome`: `surfaceOpen` (Sixkey's three pages, not the offscreen document, another extension's page, a web page, an error); `p1For` (the verified entry and the summaries with the session key's handles; locked, locked between the open and the key's read, a failed tag); the worker's listener answering and logging `accounts.list` with no account in the log, turned off at once; `invokeOnAccount` (the event, the handle and the summary, the window's hash; and nothing sent when turned off, P1 taken away, the tag failing, locked, or `thisSite` not met); a surface port refusing at once after Off and Remove |
| `plugins-w2a-dom.test.ts` | 6 | the approval screen's Sensitive part and its absence; the account entries' 600 ms after appearing, after the focus, a press begun inside; the P0 entries' click at once; the two catalogs' keys |
| `plugins-w2a-source-rules.test.ts` | 10 | the slot in the edit sheet's `extra` alone, hidden beside an armed delete, delayed, through `invokeOnAccount`; the click's order (read, redraw, `when`, then the handle); only an account slot's body carries an account; the window's handle; a summary built field by field; K_h never stored; P1 through `accounts.ts` alone, the surface first, `locked` only for official; Main's one storage read; which module takes which text; the reader fixture (its files the hello fixture's, its ID its key's, its pin its descriptor's) and the empty store catalog |
| `plugins-rekey.test.ts` | +1 | over a real runtime: an approval with the key read before a rotation is refused and writes nothing; the retry with a fresh key leaves a record that verifies with both plugins |
| `plugin-sdk-cross.test.ts` | +2 | the fake against `dispatch` for `accounts.list` across P1's world (4 levels × 2 grants × 2 ceilings × 3 states × surface × lock × tag × 10 senders × 3 messages: 11,520 runs) and an account entry's click against Sixkey's `invokedBody` |
| `plugin-sdk-client.test.ts` | +3 | `accounts()` through the fake (surface, lock, tag, off), an account's click, the client's refusal of a malformed `account` |

**Unit, changed on purpose** (each for its reason): `plugins-core` (the offer examples moved to P2 and `account.primary`;
the slots test: `account.actions` for official and listed), `plugins-protocol` (hello's `unavailable` example is P2's
`accounts.add`), `plugins-dom` (`Entries` takes `words`), `budget-split` (the `plugins-popup` budget in both places),
`plugins-source-rules` (`servePlugins` takes P1's availability; `recordVersions(keys, …)` inside the fresh-key retry),
`plugins-w1b-source-rules` (the gate's read and `touchSwitch` through `withFreshKeys`), `plugins-worker` and
`plugin-sdk-port-cross` (the stand-in storage holds the record the page verified, since a port now reads it at each
message).

**e2e, new:** `plugins-w2a.spec.ts`, two tests with Sixkey, the hello plugin and the reader: (1) the approval screen's
Sensitive part, hello's grant and `unavailable`, `unavailable` with no Sixkey page open, the list with the popup open
(eight fields, handles stable, no secret), the edit sheet's entries with their provenance (no `thisSite` entry, no code
entry), a click right after the focus not taken and one 700 ms later carrying the handle and the summary, no entry beside
an armed delete, the request log without an account, and the lock (the popup on its lock screen) answering exactly as no
page; (2) the P0 plugin never gets the list, Off answers `disabled` at once and empties the edit sheet, On brings it back,
a record whose tag fails answers `not-granted` with Sixkey open and is kept.

**Mutants** (`tools/w2a-mutants.py`, copies in the snapshot folder): 63 hand-made, one idea each, each killed by an
`AssertionError` of the named tests (the runner refuses a kill by any other error). They cover the sender (1), the tier and
listed-only (4), the lock and the surface (7), the tag and the verified entry (6), the pause (1), revocation on an open
port and at the click (5), the field filtering, the order and the handles (9), the account slot and the window (8), the
screens and the delay (5), the approval's marking (1), the offer (1), N5 (3), N2 (5), and the SDK's mirror (7). The first
run killed 60; three were killed by something other than an assertion or not at all (a locked view with a live key, a
missing element read as `TypeError`, a `StaleKeyError` thrown through a test), so those tests were sharpened and the three
killed on the rerun. **e2e mutants** (`tools/w2a-e2e-mutants.py`): 5, each killed by `plugins-w2a.spec.ts`: the account
entries not delayed, every moment a Sixkey page, `locked` told to a listed plugin, the entries beside an armed delete,
P1 not marked apart.

**Runs, all on the delivered tree** (logs in the snapshot folder, `scratchpad/w2a/`):

- **Gates** (`gates-1.log`), all passed: `messages.py`; `npm run typecheck` (the SDK's own tsconfig included); the prod,
  e2e and dev builds and the store build with the sync interface (gate open), each with check-dist; `npm run
  format:check` (formatted only through `npm run format`); no stray `.orig` or `.rej`.
- **Unit, full**, under the heavy lock (`unit-2.log`): 274 files; 4,125 passed, 4 expected fail, 1 skipped, 0 failed.
  W1c delivered 4,060; W2a adds 65.
- **e2e, full**, in a copy with the API port moved off 8787 (in 18 files, both manifests checked) and no
  `/e2e/` in its path (`e2e-full.log`): 398 passed, 1 skipped, 0 failed, in 29.4 minutes (W1c: 396; W2a adds 2).
  `perf.spec` (the six reads at a popup's open) passed in it. 127.0.0.1:8787 was never touched.
- **`e2e:sync`** (`e2e-sync-2.log`): 12 passed. (A first run failed all of them at setup: the working copy had no
  `api/server/.venv`, which the copy's tar leaves out; the venv was cloned into the copy, outside the patch, and the
  suite run again.)
- **Mutants, final run on the delivered tree** (`mutants-final.log`): 63 of 63 killed by assertions; **e2e mutants**
  (`e2e-mutants.log`): 5 of 5.

## 9. The brief's hard requirements

- **A. No P1 data reaches** an unlisted plugin (`developer-mode` by message and on a port, no account entry; tests
  and mutants M02 to M04), a P0-only plugin (`not-granted`, the vault not read; M05, M34; e2e), a locked vault
  (`unavailable`, `locked` only to an official plugin; M06, M07, M12; e2e), a paused or suspended grant (`suspended`
  before the vault; M19, M14), or a grant whose tag fails (`not-granted`; M13, M17, M18, M24; e2e). Revocation counts at
  once on a port (M20 to M22) and at a click (M23).
- **B. No new `chrome.storage` read at popup open:** Main's only read is wave 1a's (a source rule); the account slot reads
  only in its click; `perf.spec` passes in the full e2e run.
- **C. Unknown senders:** unchanged: the browser refuses an ID outside `externally_connectable.ids`, the worker drops what
  has nothing to answer to, and no answer depends on P1 for them; the W1a tests of it pass unchanged.
- **D. No new permission:** the store build's manifest is byte for byte the base's; the e2e and developer builds' differ
  only by the reader's ID in `externally_connectable.ids`, which the catalog generates. `runtime.getContexts` needs none.
- **E. Never lose data:** W2a writes nothing to the vault. P1's read is an ordinary open of the vault, the fill
  shortcut's (an unfinished key change's own clean-up runs there as at any open); nothing of P1 is stored but the log's
  line and the window's hash.

## 10. For W2b

- **The budgets left:** a vault's page with every lazy catalog in has 252 B (zh_CN) of 15,360; the settings parts have
  165 B; the popup has used 59 of its +500. The change list's words cannot go in `plugins` or the core: give them a
  catalog of their own, loaded by the change list's view only, and then count that view as the real view it is (its
  parts and its own catalog), proven by reachability in check-dist as W2a proved the popup's words out of the settings
  page; flag it, and keep the limits.
- **The interaction window** is ready: `spendWindow(id, "add-list", now)` after an `add.sources` click,
  `spendWindow(id, "account", now, handle)` after an account entry's (the request's handle must be the clicked one; the
  window holds a hash). Nothing spends it yet.
- **Handles back to accounts:** recompute `handleOf(handleKey(vk), pluginId, entry.id)` over the live entries (no map is
  stored; K_h is derived). A handle of another vault key, or another plugin's, finds nothing (`not-found`).
- **Tagged writes** go through `withFreshKeys`; a write under a retired key throws `StaleKeyError` and writes nothing,
  and one that meets a key change's clean-up still to do throws `CleanupPendingError`, is tried again after the fixed
  waits, and then reaches the page, which says _try again_ (§11). P2's writes to the vault are not grant-store writes,
  but the change list's Add must handle both the same way.
- **The input delay on `add.sources`** (the review's W2A-11, not done in W2a): wave 2a leaves P0 entries undelayed
  because they hand over nothing. In W2b a click on an `add.sources` entry opens an interaction window that lets the
  plugin put up a change list for `accounts.add`: a click with the character of consent. Give it the delay (`Entries`'
  `delayed`, and `rearm` for _More plugins…_), or say why not.
- **Check again at the decision**, as `invokeOnAccount` does: the change list's Add must read the grant store verified
  then (a plugin turned off since the list opened gets nothing written), and the ports' entry is already narrowed at each
  message.
- **P2's bodies** are already held at step 3 (a lone surrogate anywhere: `invalid`); the change list must still draw the
  plugin's issuer, label, group and `source` through `displayText`, and store them only after the user's Add.
- **The approval screen's `SENSITIVE`** set takes P2's capabilities; Appendix B has their words. Settings' row mark
  reuses them.
- **The SDK:** the client's helpers and the fake's change list for P2, the cross test extended the way P1's was, the guide
  (`docs/sdk/GETTING-STARTED.md`) and the import sample; the reader fixture can grow P2 (its catalog ceiling and pin then
  change together, and the hello plugin stays P0).
- **Owner items** from §7: the wording with the data-transfer text (OQ3), still open; a developer mode, decided
  2026-10-30 as recommended (OWNER-DECISIONS/19 Q1 (a): none in the store build, the developer build's own list instead;
  implemented, `DEVREAD-NOTES.md`); the "lock every time" responder, decided 2026-10-30 as recommended
  (OWNER-DECISIONS/19 Q2 (a): not built, `unavailable` kept).
- **"Sixkey open"** is the toolbar popup or the side panel (§11, W2A-02). A change list, or any P1–P3 moment that wants
  "the user is looking at Sixkey", should reuse `surfaceOpen` rather than count tabs.

## 11. After the review: round 2

The independent review (`scratchpad/w2a/REVIEW.md`, verdict "修改后通过": one blocking finding,
four to fix, six suggestions) and the maintainers' decisions on it. Each item: what changed, where, and what holds it.
The review's probes and mutants (`REVIEW-*` in that folder) are the reviewer's and were not edited; copies of the mutant
runners, re-pointed at this tree, are in `tools/` there.

- **W2A-02 (blocking): "Sixkey open" is its toolbar popup or its side panel, nothing else.** A plugin could open
  Sixkey's own page itself (`chrome.tabs.create`, `chrome.windows.create`, no permission) and then read the list with
  no Sixkey page in front of the user; open, the list said unlocked, and `unavailable` said locked (the review's RP-1).
  Now `surfaceOpen` asks `runtime.getContexts` for `POPUP` and `SIDE_PANEL` only, each at its own page
  (`src/platform/plugins/accounts.ts`); `TAB` never counts, the settings page included. The window Sixkey opens itself
  for a device unlock (`ui/DeviceUnlock.tsx`: the popup's page in a window, a `TAB`) does not count either: no plugin
  needs the list there, and telling it apart would need a mark the worker keeps; kept simple, as decided. A plugin's
  entries in an account's edit sheet still work in any of Sixkey's pages, a click carrying its own account.
  - **Tests.** `test/e2e/plugins-w2a.spec.ts` runs in a driven profile (`panel-helpers.ts launchDriven` now loads other
    extensions; `drive()` gained `popup()`, `popups()` and finds Sixkey's own worker): the list comes from the real side
    panel (test 1, 2) and the real toolbar popup (test 3), and the popup's page in a tab is `unavailable` (test 1). Test
    3 is RP-1 as a regression test, four ways (`tabs.create` of the settings page and of the popup's page, a minimized
    `windows.create`, a `windows.create` of the popup type as the device unlock opens), each `unavailable` while the
    page is a live `TAB` context of Sixkey's; and the probe the review asked for, an extension of its own made for the
    test with a popup, a side panel and `sidePanel` permission: `action.openPopup` and `sidePanel.open`, in its user's
    click, open its own popup and panel (asserted) and never Sixkey's (no `POPUP` or `SIDE_PANEL` context of Sixkey's;
    the list `unavailable`); Chrome refuses `action.setPopup` with Sixkey's address ("Ensure it is a path to a file in
    this extension"); `sidePanel.setOptions` with Sixkey's address, or the prober's panel sending itself there, opens
    nothing of Sixkey's. Unit: `surfaceOpen`'s cases (`plugins-w2a-platform.test.ts`, the filter asked for, a type and a
    page that do not belong together), a source rule, the cross test. (`plugin-helpers.ts launchWithReader`, the
    undriven launch, is kept: the review's own probes use it.)
  - **Words.** _pxCapRead_ now says when and what: _See your account names (often your email address), their groups and
    their sites, while Sixkey's popup or side panel is open. Not their keys or codes_ / _在 Sixkey 的弹窗或侧边栏打开时，
    查看你的账户名称（常常是你的邮箱地址）、分组和网站；不包括密钥和验证码_. PRIVACY.md, SDK §6.3 (and §10.6, §13, §14,
    §16.1), local-vault.md, ARCHITECTURE.md, the SDK's README and OWNER-CHECKLIST 45 and 46 say the same. Still a draft,
    for the owner with OWNER-DECISIONS/06.
- **W2A-01: a write never starts afresh while a key change is being finished** (option 1, as decided). `committed()`
  puts the new key in the session before the clean-up re-tags the grant store, and a retried write could meet the record
  still under the old key and start a new one without the other approvals (RU-1, RU-5; worse than the base there).
  - `VaultStore.cleanupPending()` reads, with no lock of its own as `activeVkId()` does, whether the change's full
    clean-up is still due (round 2: `cleanupNeeded(...) === "full"`; round 3 narrowed it, §12);
    `grantKeys()` hands it out with the key. `GrantStore.write()`, inside its lock, refuses a record that does not
    verify under its key while that is true: `CleanupPendingError`, nothing written, nothing set aside.
  - `withFreshKeys` tries again after fixed waits, `CLEANUP_WAITS` = 100, 200, 400, 800, 1,600 ms (3.1 s in all), then
    throws: at most 1 + 1 + 5 tries, deterministic; the wait is injectable for tests. Settings › Plugins says _Sixkey is
    still finishing a change. Try again in a moment._ (Allow keeps the approval screen open; a switch or Remove reloads
    the list), the autofill switch says the same under itself; nothing is lost, and Allow again works once the clean-up is
    done. The popup's `touchSwitch` already ignores a failure (the gate's next use writes again).
  - `committed()` and `finishUnlock()` keep their order.
  - **Residuals, stated.** A clean-up cut short (a worker stopped half-way) is finished at the next unlock or open of a
    Sixkey page; until then such a write only asks the user to try again, and a verified read lists the record's plugins
    for review (nothing changed). (Round 2 also counted a new vault's missing `sk_store_v` as due, which refused every
    approval beside a record left from a vault before it until a popup had been opened: the r2 review's R2-01, fixed in
    §12.) In the window a P1 read finds no verified entry and answers
    `not-granted` for a moment, and a `hello` then leaves `accounts.read` out (W2A-09).
  - **Tests.** RU-1 (`plugins-w2a-r2.test.ts`: the old key refused, the new key's write waits one 100 ms wait for the
    re-tag, both approvals, nothing for review), RU-5 over a real runtime (`plugins-w2a-r2-rekey.test.ts`: the approval
    started during the rotation's clean-up, its tries old, new, new, one wait, both approvals, `cleanupPending` true then
    and false after), a refused write leaving storage byte for byte as it was, the old behaviour kept with no clean-up
    due, no look at the marker on the normal path, and `withFreshKeys`' tries counted (five waits then the error, with an
    operation that would have succeeded at the 21st: an unbounded mutant fails an assertion, never hangs; three waits;
    stale then pending; R01, R02). The reviewer's RU-5 as written awaits the approval inside the clean-up, so the two wait
    for each other: the bounded tries end it after 3.1 s with the approval refused and the other approval kept (`ids`
    `[PID]`, nothing for review), so that probe still fails by design; the regression test starts the approval during the
    clean-up without the clean-up waiting for it, as two contexts do.
  - SDK §6.6 item 6, §5 above and local-vault.md no longer call N2 closed in round 1's sense; they say what is closed
    now and what is left.
- **W2A-03: "More plugins…" arms the delay again.** `useInputDelay()` returns `rearm`; `Entries`' More calls it. The
  revealed entries, and the others, ignore a press, pointer or key, for 600 ms (RU-2 and R09 in
  `plugins-w2a-r2.test.ts`, a source rule).
- **W2A-04: the fourth version comparison.** `versionSince(chrome, approved)` (`core/plugins/descriptor.ts`, by
  `sameVersion`) draws Settings' "updated to version X" line (RU-3b). A search of the platform's code finds no other
  plugin version compared as a string (a source rule holds `core|platform|ui/plugins`, Settings' and the popup's plugin
  modules to it); the sync engine's `clientVersion` identity check is Sixkey's own build string, as intended.
- **W2A-05: the cross-page rule is tested, cheaply.** It moved out of check-dist into `scripts/plugin-pages.mjs`
  (`pluginPageProblems`, the kinds; check-dist calls it, behaviour unchanged), which
  `test/unit/check-dist-plugin-pages.test.ts` holds to small builds written for it, no build needed: the pristine one
  passes; BP-1, BP-2 and BP-3, a text loaded statically, a page's own text out of reach and the platform in a page's
  static graph each fail with their line; R16 and two more mutants of it are killed. `m5-check-dist.test.ts` holds a real
  build to it once (BP-3), so check-dist is known to call it.
- **W2A-06: the wording.** "The answers are byte for byte the same; their timing may differ by about 1 ms" (README,
  OWNER-CHECKLIST 46, local-vault.md, SDK §6.3, §10.6, §13), and that an `ok` itself says Sixkey is open and unlocked.
  (Round 2 makes the locked path cheaper: it reads the session's key and opens no vault.)
- **W2A-07: the order.** (b) `p1For().vault()` verifies the grant store first and opens the vault only in `accounts()`,
  after the protocol has checked the verified entry: a plugin refused at step 7 makes Sixkey decrypt nothing. (a) Once
  the summaries are assembled, `accountsList` asks the key (`still()`: the session holds the same key) and the surface
  again; closed, locked or re-keyed meanwhile gives the answer the start would have. **Residual:** a popup closed in the
  microseconds between that last question and the answer's delivery; a key change between them is the same.
- **W2A-08: the review's surviving mutants**, each now killed by an assertion: R01, R02 (`withFreshKeys`' counts), R05
  (5,000), R09 (a key press), R13 (a pause taken while a port is open, `plugins-w2a-platform.test.ts`), R18 (a lone low
  surrogate), R20 (the refused-term notice: every offered slot, by `OFFERED_SLOTS`, and a source rule), R21 (`More`
  filtered by `when`: `slots.ts onAccountOnly`, tested; and in the e2e, the reader fixture's third entry, for HOTP
  accounts only, falls under More and must not show on a TOTP account: its pin in `plugins/catalog.test.json` changed
  with it), R23 (an uppercase host), R12 and R19 (source rules; the e2e kills
  them too).
- **W2A-09: `hello`'s P1 never disagrees with `accounts.list`.** Whenever the list would reach its tag (the same
  `reach()`: the surface first for a plugin that is not official), `granted` holds `accounts.read` only if the verified
  record does; otherwise the stored record's, and the list then answers `unavailable` or `locked`, never `not-granted`.
  SDK §5.2 and §16.1. The one case where `hello` then depends on the lock is the one where the list already does: a record
  whose tag fails, with the popup or the side panel open.
- **W2A-10: the cross test compares real configurations.** The port channel passes no `p1`, as `port.ts` never does, and
  the fake answers P1 on a port `unavailable`; `hello` joined the P1 loop.
- **W2A-11 (for W2b):** noted in §10.

**Runs on the delivered tree** (logs in the snapshot folder):

- **Gates** (`r2-gates-2.log`), all passed: `messages.py`; the typecheck; the prod, e2e and dev builds and the store
  build with the sync interface, each with check-dist; `npm run format:check`; no stray `.orig` or `.rej`. The store
  manifest is still the base's.
- **Budgets** (gzip bytes, zh_CN; base → round 1 → round 2): popup, gate closed 58,006 → 58,069 → 58,106 (61,440); gate
  open 59,259 → 59,318 → 59,378 (+119 of the +500 allowed); side panel 60,234 / 61,486 → 60,301 / 61,543 → 60,338 /
  61,605 (63,488); settings, every part, 12,123 throughout (12,288); a vault's page with every lazy catalog in 15,048 →
  15,108 → 15,155 (15,360; 205 left); the settings page's plugin text 1,730 → 1,805 → 1,869 (3,072); the popup's 396
  (2,048). Round 2's bytes: `cleanupPending` beside `activeVkId` in the core, `pxTryAgain` and the longer `pxCapRead`.
- **Unit, full** (`r2-unit-2.log`): 277 files; 4,161 passed, 4 expected fail, 1 skipped, 0 failed (round 1: 274 files,
  4,125). After the runaway run below, two test files changed (the sentinel getters); they, the typecheck and the format
  check were run again (`r2-rerun-checks.log`: 4 files, 64 passed).
- **e2e, full**, in a copy with the API port moved off 8787 (18 files, both manifests checked) and no `/e2e/` in its
  path (`r2-e2e-full-2.log`): 399 passed, 1 skipped, 0 failed, in 29.5 minutes (round 1: 398). 127.0.0.1:8787 was never
  touched. **`e2e:sync`** (`r2-e2e-sync-2.log`): 12 passed.
- **The review's RP-1, as the reviewer wrote it**, on that copy (`r2-review-rp1.log`): before, and for each of its three
  ways, `unavailable` (round 1: `ok`, with the list).
- **Mutants**, each killed by a failed assertion or expectation, none by a timeout:
  - mine, unit (`tools/w2a-r2-mutants.py`): 89 of 89 (`r2-mutants-2.log`); the ten about retries and keys (M52 to M56,
    M63 to M67) again with the new runner (`r2-mutants-3.log`): 10 of 10, no timeout;
  - the reviewer's 25 unit mutants, re-pointed (`tools/review-mutants-r2.py`, `r2-review-mutants-3.log`, new runner): 25
    of 25, no timeout (R02 in 9 s);
  - mine, e2e (`tools/w2a-r2-e2e-mutants.py`): 6 of 6; the reviewer's 3 e2e mutants (`tools/review-e2e-mutants-r2.py`):
    3 of 3, RE21 included (`r2-e2e-mutants-2.log`, `r2-review-e2e-mutants-2.log`; each under 30 s, no timeout).
- **The runaway run, and its fix.** The reviewer's R02 (unbounded retries) made round 1's `withFreshKeys` test in
  `plugins-w2a.test.ts` (a getter that always gives a key, an operation that always throws `StaleKeyError`) loop for ever
  in microtasks. The runner's `subprocess.run(timeout=1500)` then killed only `nice`/`npx`: vitest's own processes,
  orphaned, ran on at 100% CPU, one for over two hours, until the maintainers killed them; and an earlier summary counted
  that 1,500 s timeout as a kill (corrected here: R02 was a timeout then). Fixed: every runner starts each command in a
  process group of its own and kills the whole group (and Playwright's browsers, by their path) on a timeout, an error or
  a signal, and after every run (`tools/rungroup.py`); the timeout is five times the pristine run of the same tests, 30
  to 180 s; a timeout is counted apart and never as a kill. The wrappers and chains run each step as a job in its own
  group and kill it when stopped (`tools/guard.sh`); `tools/leftovers.sh` checks for processes under the work folder
  before every start. And the tests: the getters of `withFreshKeys`' tests throw a sentinel at the first call past the
  allowed ones, and the exact count is asserted, so R01, R02 and an unbounded retry fail in milliseconds.

## 12. Round 3: a new vault beside an old grant record

The review of round 2 (`REVIEW-r2.md`, "修改后通过") found one thing to fix and three to suggest; the maintainers chose
the fix after a probe of mine showed that the review's option (a) alone would not do (`r3-probe-newvault.test.ts` and
`.out` in the snapshot folder).

- **R2-01: every Allow answered "try again" after a new vault was made beside a record left by a vault before it.**
  Round 2 counted a new vault's missing `sk_store_v` as a key change still being finished. Two changes, both kept:
  - **(a) `VaultStore.cleanupPending()` is an unfinished key change of this vault, nothing else**
    (`keyChangeUnfinished`, `core/storage/store.ts`): a full key-change marker (any present marker but one left for the
    mirror alone), or `sk_store_v` naming one of this keyring's previous keys. The lack of `sk_store_v` alone is not one.
    A store from before the marker that has previous keys and no `sk_store_v` is not counted either, by this rule; no
    grant record can be under one of its previous keys, since the grant store is younger than the marker.
  - **(b) A new vault sets aside the grant record left beside it** (`GrantStore.newVault`, called by `makeVault`
    through a new, optional `VkRecord.newVault` hook, after `dropStalePin` and `dropStalePrf`, never failing the vault's
    making). Option (a) could not cover it alone: a vault made over unreadable data (Start over, a backup restored over
    it) is written with a full marker, which only its first open or unlock clears. Every way to a new vault makes a new
    vault key (`prepareKeys`: a new VK, no previous key), so no record left beside it verifies, and no clean-up can
    re-tag one. What (b) does:
    - a record that verifies under the new key (none can) and no record are left as they are, byte for byte;
    - otherwise the record is set aside as a tagged write sets aside a failed one: kept in `sk_plugins_unverified`
      (listed for review, never honoured), then a new record under the new key in its place, the overlay merged into it
      and removed. One difference from the maintainers' wording ("delete `sk_plugins` and the overlay"): the new record
      holds the built-in autofill's Off if the user had turned it off. Deleting would turn autofill back on, since no
      record means On, which W1b's N-01 forbids;
    - if a record was kept aside already (a vault before that one), the new one's plugins are merged into it, so none is
      dropped (a tagged write keeps only the first failed record).
    - **Cut short** (a storage error at either step): the vault is made all the same, and what is left is a record that
      does not verify beside it. With no marker (the first run, a restore onto an empty store) the first write sets it
      aside itself; with Start over's marker the write is refused until the clean-up an open runs, which Settings now
      runs once after the refusal (below). Both are tested, each at both steps. Nothing is lost either way. (Corrected
      in W2b: until then, a cut short at the first step beside a list kept before could drop the old record's plugins
      from the review list, the r3 review's R3-01; a tagged write now merges a failed record into what is kept,
      PLUGINS-W2B-NOTES.md §5.)
  - **Tests** (`plugins-w2a-r3.test.ts`, over real runtimes on shared storage and a shared vault lock, as Chrome's
    navigator.locks): (a)'s cases (a new vault, a full, damaged, mirror-only or other key's marker, `sk_store_v` naming a
    previous key, another key, a newer version, none); R2-03 (only the mirror left, a record that does not verify: the
    write lands, the old record for review); the five ways to a new vault (the first run beside a record left, a backup
    restored onto an empty store, Start over over unreadable data, the same vault's backup and another vault's restored
    over it), each: a new vault key, under which the old record does not verify (asserted), the old record kept for
    review, the first approval written at the first try, the old plugins approved again on asking; autofill's Off kept; a
    verifying record untouched; a kept list merged; and the fault-injection cases. e2e (`plugins-w2a.spec.ts`): the
    review's RP-4 as a regression test (a real record, made in another profile with the reader approved, put beside a
    first run made as RP-4 made it, no popup opened after the wizard, so no `sk_store_v` yet: the record is kept for
    review, and the reader's first Allow lands, with no "try again"; it fails with round 2's code, mutant E7).
- **"A restore of the same vault keeps its approvals": withdrawn.** It cannot: a restore always makes a new vault key, and
  the grant record's tag key is derived from it. After a backup is restored or Sixkey starts over, plugins need to be
  approved again; the earlier approvals are listed for review. PRIVACY.md, local-vault.md, SDK §6.6 item 6 and
  OWNER-CHECKLIST 46 say so, in text already there (no new screen text).
- **After a refused write, Settings runs the clean-up an open would run, once** (`runPendingCleanup`,
  `core/plugins/store.ts`; the maintainers' conditions): only after `CleanupPendingError`, once per click; only while
  Sixkey is unlocked here (the session holds the key), never while locked; it is `openView`'s housekeeping, the one
  cleanup entry point, under the vault lock and idempotent; the refused write is not tried again, the user tries, and
  the words are unchanged. Tested: two contexts finishing one cut-short key change at once re-tag once (`rewritten`,
  then `current`), neither fails, the marker goes, the approval kept; locked, it opens nothing; a failing open does not
  throw; source rules for Allow, a switch and the autofill switch. e2e: a cut-short key change (its full marker and a
  record not under the key) makes Allow say try again after its bounded tries, Settings finishes the clean-up (the
  marker goes with no popup opened), and the next Allow lands.
- **R2-02:** Allow clears the line of an earlier try as it starts (`setProblem(null)`); the e2e above asserts that the
  line is gone after the second Allow, and a source rule holds it.
- **R2-03:** the test above; N03 is killed (below).
- **R2-04:** the e2e's test 3 also has the prober's own popup sending itself to Sixkey's popup page
  (`setPopup("popup.html?go=…")`, then `openPopup`): it opens, and nothing of Sixkey's opens.

**Runs on the delivered tree** (logs in the snapshot folder):

- **Gates** (`r3-gates.log`), all passed: `messages.py`, the typecheck, the prod, e2e and dev builds and the store build
  with the sync interface, each with check-dist, `npm run format:check`, no stray `.orig` or `.rej`; the store manifest
  is still the base's.
- **Budgets** (gzip bytes, zh_CN; round 2 → round 3): popup, gate closed 58,106 → 58,175 (61,440); gate open 59,378 →
  59,444 (+185 of the +500 allowed over the base's 59,259); side panel 60,338 / 61,605 → 60,406 / 61,675 (63,488); the
  text budgets unchanged (settings every part 12,123; a vault's page with every lazy catalog in 15,155; the plugin
  catalogs 1,869 and 396): round 3 adds no word. Its bytes are (a)'s check and makeVault's call of the records' hook.
- **Unit, full** (`r3-unit.log`): 278 files; 4,178 passed, 4 expected fail, 1 skipped, 0 failed. (A first run failed
  one test that pins VaultService's members, `budget-split.test.ts`: round 3 had added a private method; the loop was
  put inside `makeVault` instead, and everything was run again.)
- **e2e, full**, port moved off 8787 (18 files, both manifests checked), no `/e2e/` in the copy's path
  (`r3-e2e-full.log`): 401 passed, 1 skipped, 0 failed, in 31.6 minutes (round 2: 399; round 3 adds the RP-4 regression
  and the cut-short key change). **`e2e:sync`** (`r3-e2e-sync.log`): 12 passed.
- **Mutants**, each killed by a failed assertion or expectation, no timeout:
  - mine, round 3's own and those about cleanupPending and retries (M52 to M56, M63 to M67, M90 to M104;
    `r3-mutants.log`): 25 of 25. Among them the maintainers' four: a missing `sk_store_v` counted as pending (M90),
    (b) gone (M94, and M95 the hook), (b) touching a record that verifies (M96), (a) missing the full marker (M91); and
    N03's idea (M93);
  - the reviewer's r2 ones about the same (`tools/review-r2-mutants-r3.py`, N03 re-anchored; `r3-review-mutants.log`):
    N01 to N06, R01, R02, 8 of 8;
  - e2e: E7 (round 2's new vault: (a) and (b) both undone) killed by the RP-4 regression (`r3-e2e-mutants.log`).
- **Runners.** All through `tools/rungroup.py`, `tools/guard.sh` and `tools/leftovers.sh`; no timeout; no process left
  under the work folder after any step; `heavy.lock` given back. One fault of mine in round 2's wrapper change, found and
  fixed here: `tools/e2e.sh` ran its work without the script's arguments (`guarded work` for `guarded work "$@"`), so a
  run meant for one spec ran the whole suite (it was used as a full run; a later full run is the one counted above).
