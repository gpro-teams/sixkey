# Plugin platform, wave 2b: P2 behind Sixkey's change list, the import sample, and the SDK's P2

The second half of wave 2 of the plugin platform (MOD-PLATFORM §7.1, row W2; the owner's "做第二期", 2026-10-26),
after W2a (P1, `docs/design/notes/PLUGINS-W2A-NOTES.md`). W2b builds P2 (`accounts.add`, `accounts.update`,
`accounts.trash`, SDK §6.3) behind Sixkey's own change list and the interaction window, the import sample of §12.4, the
SDK's P2 (the client's helpers, the fake's change list, the cross tests, the guide), P2's words on the approval screen,
and the four W2a leftovers (the r3 review's R3-01 to R3-03, and W2A-11). The owner's preset is OWNER-DECISIONS/16's
"balanced": P2 for reviewed (listed) plugins only, "每次改动都由 Sixkey 列出内容让你确认", and the Never list (keys, the
master password, the recovery key, the PIN, exports, security settings, sync keys) reachable by no plugin. The normative
text is the SDK spec, now revision 1.0-draft.11 (§6 lists every change: where it and the code differed, the code won).

KW-2 (MOD-PLATFORM's kill criterion for W2: "a write path that can lose or replace data, or skip the change list → stop
the write tier") did not trigger: §9 goes through it point by point.

**For the reviewer, first:** §4 (where a proposal's keys wait before the user confirms), §3.6 (the check again at the
decision), and §9 (the hard requirements, each with its tests and mutants). **The review's r2:** §11 goes through
W2B-01 to W2B-10 one by one, and §12 the r2 review's R2-01 to R2-05 and RE-2b (r3); the sections above are the
as-built text after both.

## 1. What the user sees

- **The approval screen** of a reviewed plugin that asks for P2 lists each P2 capability under **Sensitive** /
  **敏感权限**, in Appendix B's words, each with the plugin's reason quoted: _Propose new accounts (you review each time)_,
  _Propose renaming or regrouping accounts (you review each time)_, _Propose moving accounts to the trash (you review each
  time)_ (提议添加账户（每次由你确认）; 提议重命名账户或调整分组（每次由你确认）; 提议把账户移到回收站（每次由你确认）). The line
  _Sixkey cannot stop a plugin from sending what it reads to the internet._ is said only with P1 (P2 reads nothing).
  Settings › Plugins marks the row with every sensitive capability the plugin holds, in the same words.
- **A plugin's proposal**, right after the user clicked the plugin's entry (its interaction window: Add account's
  _From plugins_ for a list of accounts to add, an account's own menu for that account), is put in front at once: in
  Sixkey's side panel or toolbar popup if one is open, else Sixkey opens its toolbar popup for it (once). Any other
  proposal waits: the toolbar icon shows **!** with the title _A plugin is waiting for your answer_ (有插件在等你答复),
  and Sixkey's popup and side panel show a line _<plugin> is waiting for your answer · Review_ (<插件> 在等你答复 · 查看).
- **The change list** is Sixkey's own sheet over its unlocked list, in Sixkey's words. Always: its title (_Add these
  accounts?_, _Change these accounts?_, _Move these accounts to the trash?_) and under it _Proposed by <plugin>_ with its
  trust badge. For an add: the plugin's `source` quoted (_From: export.txt_), each account with its name and code
  settings (never its key), and how it stands: _Already in Sixkey_ (cannot be ticked), _Same key as <account>_ and
  _<account> has another key_ (left out unless the user ticks them; then added beside the old one), the new ones ticked,
  _Repeated in this list_; and _Could not read N of them_. For an update: old → new for the issuer, the account name and
  the group (_No group_). For a trash: the accounts, and _You can restore them from the trash in Settings._ Buttons: _Don't
  add_ / _Add N_, or _Cancel_ / _Apply_; both (and the ticks) ignore input for 600 ms after the list appears or is drawn
  again, after the window gains the focus and after anything around it comes or goes, and take only the user's own click.
  The list is the page's top layer while it is up: over every other sheet (an account's edit sheet, whose plugin entry
  may have put it in front, stays open under it with what the user typed), the rest of the page inert, the focus on the
  list itself (neither button), Tab kept in it, and Escape its own (it hides the list behind its line; a second Escape is
  the sheet's). Applied over that sheet, an update shows in its untouched fields, and its Save writes only what the user
  changed there (r3).
- **After the click**: the change is made in one ordinary save (sync follows, as for the user's own edits), the list
  closes, and the plugin is told the result. If an account changed meanwhile (the user's own edit, a sync), nothing is
  written: _Your accounts changed since this list was shown. Check it again._, the list drawn again with that account
  marked _Changed since this list was shown: left out_. If the plugin was turned off or paused meanwhile: _This plugin
  can no longer make this change. Nothing was changed._ If another of Sixkey's surfaces answered it first, or its time
  is up meanwhile: _This was already answered, or it expired. Nothing was changed._ (said at once when it ends under the
  list). In those cases the list stays up, with only _Close_, until the user closes it. Three _Don't add_ / _Cancel_ in a
  row within 10 minutes pause the plugin (Settings › Plugins: _Paused after you said no three times_).
- **Never**: on the lock, PIN, password, confirm, export or Settings screens; in a Sixkey page any extension opened in a
  tab or a window; while Sixkey is locked (a proposal that came then, or one a lock voided, never shows; the plugin is
  told `timeout` at its time).
- **Add account's _From plugins_ entries** now ignore a click for 600 ms after they appear (W2A-11, §5).
- **The import sample** (`extension/plugins/examples/otp-import/`): _Import from a file_ in Add account opens its window,
  which reads a file of `otpauth://` links, shows their names, and proposes them; Sixkey's change list does the rest, and
  the window says _Sixkey added 2 accounts; 1 was already there._

## 2. Budgets

W2a left 252 B of a vault's page with every lazy catalog in (205 after its r2, by check-dist), 165 B of the settings
parts, and +185 B of the popup's +500. W2b's text is mostly the change list's, which got a catalog of its own, as W2a's
§10 asked.

- **The change list's catalog**, `catalogs/plugins-changes-<lang>.json` (messages.py `PLUGINS_CHANGES`, the fragment
  `scripts/i18n/w2b.py`), is imported by the change list's view alone (`src/ui/plugins/changes-text.ts`, imported only by
  `src/popup/main/ChangeList.tsx`), which the popup's plugin chunk loads on a list's first use. Every word the list draws
  is in it but the trust badges, which are the popup's plugin catalog's (already loaded there): the platform's modules use
  no word of Sixkey's own catalogs (`plugins-source-rules.test.ts`; ChangeList.tsx is in its PLATFORM now).
- **Proven by reachability** (`scripts/plugin-pages.mjs`, a third kind with `from: "plugin-changes-"`): no chunk but the
  change list's view (`assets/plugin-changes-*.js`, named by `scripts/build.mjs`) names the change list's text; the
  settings page reaches it never; the popup and the side panel only through that view; and no page loads the view
  statically. `check-dist-plugin-pages.test.ts` holds the rule to small builds made for it (three new cases: another chunk
  naming the text, the settings page reaching the view, the view in a page's static graph). So "a vault's page with every
  lazy catalog in" still counts what a vault page can load, and the change list's view is counted as the view it is: its
  chunk, its stylesheet and its text (check-dist prints it).
- **A budget by the rule** (its measured size, 741 B zh_CN, plus at least 1.5 KB, rounded up to 512 B): 2,560 B (messages.py
  `BUDGETS["plugins-changes"]`, check-dist `PLUGINS_CHANGES_CATALOG_GZ`, held equal by `budget-split.test.ts`). **No
  existing limit was raised.**
- **What went elsewhere:** the approval screen's three P2 lines into the settings page's plugin catalog (`plugins`: it
  is the approval screen's); the popup's line _<plugin> is waiting for your answer_ into the popup's plugin catalog; the
  badge's title into the full catalogs for Chrome (`pxBadgeWaiting`, the worker's `chrome.i18n`: in no page's catalog).

**The numbers** (gzip bytes, check-dist, zh_CN where it is the larger; base = the live tree, e21c7f4 + W2a; W2b as of r3,
earlier rounds' in brackets where a round moved them; r3's field-wise Save is the edit sheet's own lazy code, Main only
applying the edit it is given: its first form, in Main and `model.ts`, cost +89 B of the popup's static code and took the
last of `sidepanel-check-dist.test.ts`'s fixed margin, so it moved):

| What | Base | W2b | Limit / allowance |
| --- | --- | --- | --- |
| Popup, gate open (store build with the sync interface): static | 54,773 | 54,815 (+42) [r1, r2: 54,846] | +300 allowed |
| Popup, gate open: total | 59,444 | 59,486 (1,954 left) [59,517] | 61,440, at least 1,500 left |
| Popup, gate closed (today's store build): total (static) | 58,175 (53,702) | 58,201 (53,728; +26) [r2: 58,237] | 61,440 |
| Side panel, gate open / closed | 61,675 / 60,406 | 61,719 / 60,430 [r2: 61,750 / 60,465] | 63,488 |
| Settings, every part together (zh_CN) | 12,123 | 12,123 (unchanged) | 12,288 |
| A vault's page with every lazy catalog in (zh_CN; check-dist) | 15,155 | 15,223 (+68; 137 left) | 15,360 |
| The same, messages.py's own sum | 15,152 (208 left) | 15,219 (+67; 141 left) | 15,360 |
| Plugins text, the settings page's (zh_CN; en) | 1,869; 1,515 | 1,951; 1,577 | 3,072 |
| Plugins text, the popup's (zh_CN; en) | 396; 319 | 415; 332 | 2,048 |
| The change list's text (zh_CN; en) | (new) | 703; 547 [741; 581: r2 dropped a word] | 2,560 (new, by the rule) |
| The change list's view with its text (zh_CN; en) | (new) | 3,874; 3,592 [3,337; 3,052: r2's top layer] | (printed: loaded on a list's first use only) |

The popup's static bytes are Main's glue: one more key in its one `chrome.storage.session` read, the two
`<plugMod.Requests>`, and the `answered` callback.

## 3. P2 as built

| Piece | Where | What |
| --- | --- | --- |
| The proposal's shapes, read back strictly | `src/core/plugins/proposal.ts` (pure) | `Proposed`, `AddProposal`, `Change`, `parseProposal` |
| Reading, the change list's rows, the edit, the results | `src/core/plugins/changes.ts` (pure) | `readAdd`, `readUpdate`, `addRows`, `updateRows`, `trashRows`, `byHandle`, `applyAdd/Update/Trash`, `Conflict`, `addResult` |
| Where a proposal waits | `src/core/plugins/pending.ts` (pure over a KV and a lock) | `PendingStore`: one per plugin, eight in all, 5 minutes, the lock epoch, the claim, the spacing, the denials |
| The order of checks | `src/core/plugins/protocol.ts` `P2_TYPES`, `propose`, `Deps.p2` | steps 1 to 5, then `pendingResult` / `busy` / `rate` |
| The worker's side | `src/platform/plugins/proposals.ts`; `worker.ts`; `background/sw.ts` | `p2For` (keep it), `inFront` (the window), `endExpired` (`timeout`), `watchPending` (every lock voids), `pendingAlarm` (from the worker's one alarm listener) |
| The badge | `src/platform/badge.ts`; `sync-worker.ts` | the toolbar's one global badge, shared with sync's status |
| The surface's side | `src/platform/plugins/changes.ts` | `isSurface`, `drawList`, `accept`, `deny`, `endWith` (each end by its claim), `mayShow`, `markTrashed` |
| The popup's view of them | `src/ui/plugins/view.ts` `viewProposals`, `proposals`; `core/plugins/session.ts seenWith` | the proposals and the lock epoch in the hellos' one read |
| The UI | `src/popup/main/Plugins.tsx` `Requests`; `ChangeList.tsx` (`topLayer`), `changes.css`; `Main.tsx` | the line, the list as the page's top layer, its delay |
| The approval | `src/options/PluginApproval.tsx` `SENSITIVE`, `CAP_WORDS`; `Plugins.tsx` | P2 apart; the internet line with P1/P3 only; the row's mark |
| The text | `scripts/i18n/w2b.py`; `messages.py`; `src/ui/plugins/changes-text.ts` | the change list's catalog |

### 3.1 Who gets a ticket (§10.6)

Only a plugin that passes every earlier step: its own context, by message (P2's sender rule is `context`: never a
surface port, so never an unlisted plugin's port); approved now (`not-approved`, `disabled`, `suspended` (a pause
included), `blocked`); a strict body (`invalid`; an update naming one account twice too, beyond the schema; a lone
surrogate anywhere); the capability in its stored grant within its level's ceiling (`not-granted`: an unlisted plugin's
ceiling is P0, a P0 or P1 plugin has no P2); within the rate (three of each type a minute). Then step 6 is `pendingResult`
(`{pending: true, ticket}`), in every lock state, at every trust level (§10.6's table); `busy` while one of the plugin's
proposals waits; `rate` (`retryAfterMs` 60,000) while eight wait in all. `sites.propose` stays `not-granted`.

Steps 7 and 8 (the tag, the plugin's verified entry approved now and holding it, the request's own checks) are the
change list's: when it is drawn (Requests: a plugin that no longer holds it is told `not-granted` at once, and nothing is
drawn) and again in the user's click (§3.6). So the answer tells nothing of the lock.

### 3.2 Reading a proposal

- **accounts.add**: each URI parsed with the popup's own rules (`core/totp/otpauth.ts`: the type, a base32 key that
  decodes to at least one byte, the algorithm, the digits, the period, an HOTP counter), within the vault's limits (a key
  of at most 512 characters, names of at most 256); one that is not an account is counted (`rejected`) and never kept.
  The names are kept as Sixkey draws them (`displayText`: NFKC, the characters plain text refuses removed, spaces
  collapsed, cut), so the list shows exactly what would be written. The `source` likewise (40).
- **accounts.update**: the issuer and the label (256), the group (64; `null`, or a group that is nothing once drawn,
  is none).
- **accounts.trash**: the handles (distinct by the schema).
- It is read in every lock state, so the work is the same whether it is kept or not.

### 3.3 The change list's rows

- **Add**: `core/import/dedupe.ts verdicts`, the popup's own rules, by the decoded key: `exists` (the same key under the
  same issuer: cannot be added), `repeat` (the same key as an earlier item: cannot), `same_key` and `rebind` (another key
  under the same issuer and label): marked, unticked by default, addable (beside the old one), `new`: ticked.
- **Update and trash**: each handle resolved over the live accounts under K_h of the key held now (`byHandle`, W2a's
  handles); one that names nothing is _not found_; an update that changes nothing is _no change_. Each resolved row keeps
  the account's ID and its three stamps (content `hlc`, place `phlc`, deletion `dhlc`), which every edit, a sync's
  merge included, moves.

### 3.4 The interaction window and the badge (§6.4)

- **In front** only when the proposal spends the window its plugin's click opened (`session.ts spendWindow`, W2a's):
  `add-list` after an `add.sources` click for an add; `account` after an `account.actions` click for an update or a
  trash whose every handle is that account (the window holds a hash of the handle); and when the spacing allows it (one
  opening every 30 s, 6 an hour, per plugin). Then the proposal is marked `surfaced`, and Sixkey's toolbar popup is opened
  for it (`action.openPopup`, which needs no permission) unless Sixkey's popup or side panel is open already
  (`surfaceOpen`, W2a's), which draws it at once. A popup that cannot open falls back to the badge.
- **Otherwise** the badge and a Review line. The badge is the toolbar's global one, which sync's status also uses (the
  devices waiting to join): `platform/badge.ts` holds both and draws the waiting mark while it is up (5 minutes at most),
  sync's otherwise, so neither undoes the other.
- **Busy, the denials**: one proposal per plugin at a time; three denials in a row within 10 minutes pause the plugin
  (`GrantStore.pause`, W1a's `sk_plugin_pauses`), and an Add or Apply starts the count again.

### 3.5 Drawn where, and how

- Only in Sixkey's toolbar popup or side panel: `isSurface()` asks `tabs.getCurrent()` (which gives a page its own tab,
  and nothing in a popup or a side panel; no permission) and `surfaceOpen()` (a `POPUP` or `SIDE_PANEL` context of
  Sixkey's at its own page). A Sixkey page any extension opens with `tabs.create` or `windows.create` draws none (the
  W2A-02 rule, reused as W2a's §10 asked).
- Only on the unlocked list: Main draws `Requests` in the list's view and in Add account's (where the click on an
  `add.sources` entry happens), nowhere else; the lock, PIN and password screens are not Main, and the confirm page, the
  export and the settings page never mount it (a source rule; the platform's existing rule that those screens reach none
  of the platform covers ChangeList.tsx too).
- **No read of its own at the popup's open** (W2B-04): Main loads the plugin chunk as before (the page hint, else its
  one session read, now of two keys: a proposal waiting counts as a hello does). The popup's plugin chunk asks its plugin
  view to carry the proposals (`viewProposals()`), and the view reads them, with the lock epoch, in the same one get as
  the hellos (`seenWith([PENDING_KEY, LOCK_EPOCH_KEY])`); `Requests` uses that view, the one the popup's button and
  quiet line read, and reads it afresh only when the proposals change (`watchProposals`, storage.session's `onChanged`).
  So an open of the side panel or the toolbar popup reads `chrome.storage` as often as before P2, with a plugin
  approved and a proposal waiting or none: `plugins-w2b-r2.spec.ts` counts every `get` of both areas at each open in the
  real browser and holds them to the base's (the side panel 10 and 7, the popup 11 and 10, as the review measured the
  live tree). `perf.spec`'s six local reads (no plugin) hold too. A list drawn at the open (one put in front) reads what
  it draws (the vault's view, the handles' key) after it: that is the list's own work, not the open's.
- **The page's top layer** (W2B-02, W2B-03): `ChangeList.tsx topLayer` makes every element of the page but the list inert
  (each sibling of the list and of its ancestors up to the body, and any added there while it is up, by a
  MutationObserver, which also arms the delay again when an element comes or goes there), and undoes only what it did;
  the list's z-index is above every sheet's (20 over 6); it takes the focus (the container, `tabindex="-1"`), keeps Tab
  and Shift+Tab within its own buttons and ticks, takes Escape in the capture phase before any sheet hears it, and gives
  the focus back where it was when it goes. Main no longer closes an account's edit sheet when a proposal is answered.
- **It says why it cannot be answered** (W2B-06): `Requests` keeps the list up when its proposal leaves the store (and
  keeps who proposed it as drawn, since a plugin turned off has no approved provenance any more); the list then says
  _This was already answered, or it expired._ unless its own decision has already said what it came to.
- Every string a plugin gave is drawn through `displayText` again at drawing (`pt()`), though it was stored so already.
  The names of the vault's own accounts are the user's text, drawn as text.

### 3.6 The decision, checked again in the click (as `invokeOnAccount` does)

`platform/plugins/changes.ts accept`, in this order (a source rule holds it):

1. **The record, verified now**: `withFreshKeys(grantKeys, grantStore().read(k))` (N2's retry: the verified read merges
   a pending overlay, a tagged write, which a key change can retire; it never meets W2A-01's pending clean-up, which only a
   record that does not verify can, and such a record is simply not ok, so r2 dropped the unreachable "try again"
   branch); the plugin's entry in the verified record approved now by `stateOf` (its pauses, a listed plugin's pin,
   `minVersion`, the version under `management`) and holding the capability within its level's ceiling (`slots.ts
   holdsNow`). A record whose tag fails, a plugin turned off, removed, paused or no longer holding it: nothing is
   written, and the plugin is told `not-granted` if this surface can end the proposal (its claim, below; else another
   surface is deciding it, and this one says it was answered). Locked meanwhile (no key): nothing is written, nothing
   is sent (the lock voided it).
2. **The claim**: the proposal is still the user's to decide (within its time, of the lock epoch it came in, with its
   contents, not being written), and no other surface holds it (`claim`, 30 s): else _This was already answered, or it
   expired._ The claim is this surface's from here on: only its holder can end the proposal, free it or mark it
   (`finish`, `release` and `writing` take the claim, W2B-01). Then it is marked **`writing`**, before the write: from
   then on it is never drawn or claimed again.
3. **The write**, one `service.mutate` (the vault's own locked read-edit-write; sync's outbox follows as for the user's
   own edits), inside which: for an update or a trash, each row's handle must still name that row's account under the
   key step 1 read (a key change since then: none does, and nothing is written; W2B-09: the key is read before
   `mutate`, not inside it); and each account must be alive and unchanged since it was drawn (its three stamps); for an
   add, each row's standing must be what was drawn. Any difference is a `Conflict`: the write throws, nothing at all is
   written, the claim and the mark are released, and the list is drawn again from the vault as it is, those rows marked
   and left out, the delay armed again.
4. **The end**: the proposal finished by its claim, the denials reset, `request.done` with the result, a log line
   (`done`), and for a trash the plugin's trash marks (§3.8).

A denial (_Don't add_, _Cancel_) and Requests' `not-granted` at a list take the claim first too: one that another
surface holds, or that is being written, is not ended there, nothing is sent and no denial is counted (the list says it
was answered). Taken, a denial is the proposal finished, `request.done` `denied`, a log line, the denial counted.

**One ticket, one result; the residual** (W2B-01, and r3's R2-05). Every result is sent by the one end of the
proposal that took it out: a surface's by its claim, the worker's sweep at its time only once no claim holds it (a
claim lapses 30 s after it is taken). So a decision whose write outlasts its claim and the proposal's time, and that
the sweep ended first (`timeout`), sends nothing more when it ends (`finish` by its claim finds it gone): never two
results (the r2 review's RP-R1 had `["timeout","ok"]`). What remains (the r2 review's R2-04, not done, as the
maintainers decided): such a decision, and one whose page closed after the write and before its end (the toolbar popup
closes when it loses the focus), end `timeout` though the change was made (never a `denied` that is false, and no
denial is counted). Nothing is lost or written twice when the plugin tries again: an add's accounts are then _Already in
Sixkey_, which no one can tick; an update's rows are _No change_, which leaves Apply disabled; a trash's are _Not found_
(the r2 review checked all three: RP-U5, RP-R4). A plugin that must know reads the vault again (`accounts.list`, with
P1), or reads `duplicates` in the result of its retry.

### 3.7 The results (`request.done`, §10.5)

`{ticket, ok: true, result}`: an add's `{added, duplicates, rejected, handles}` (`duplicates`: the rows already there,
the same key as another, or repeated, left out; `handles`: the added accounts' handles in the request's order, `null` for
every other one), an update's `{updated}`, a trash's `{trashed}`. Or `{ticket, ok: false, error}`: `denied`, `timeout`
(its 5 minutes up: an alarm at the first proposal's end, and every start of the worker, end them; one a lock voided ends
so too), `not-granted`. Sent by message to official and listed plugins, never waited for.

### 3.8 The trash marks (§9.7)

After a trash, the accounts' IDs are added to the plugin's grant entry (`trashed`, the newest 5,000; `grants.ts
markTrashed`, `GrantStore.markTrashed`), a tagged write of its own (the trash is done either way), as W2a's Settings
writes are (W2B-08): `withFreshKeys` (a fresh key after a key change; again in a moment while one is being finished),
then, if that change's clean-up is still due, the clean-up an open would run, once (`runPendingCleanup`), and one more
try; marks that still cannot be recorded are lost, and the diagnostics log says so (its class only). The Trash's _Moved
to the trash by <plugin>_ and "Erase old items" listing them apart are not drawn yet (§7). (2026-10-29: budget work 3
draws the mark, and drops it from an account restored there; "Erase old items" still lists them together:
BUDGET3-NOTES.md §4. The marks' write is book-keeping now, not an approval (`onlyVerifiedChange`): over a
record that has stopped verifying since the Apply's check, nothing is written and the record stays as it is; the marks
are not kept, as they were not before, the new record having no entry for the plugin: BUDGET3-NOTES.md §11. That loss is
not in the diagnostics log: the record itself is the warning, Settings › Plugins saying that Sixkey could not check its
plugin approvals and asking the user to review them.)

### 3.9 The log (§10.10)

A P2 request by its type and its immediate outcome (`ok`, `busy` ...), and its end as a second line of the same type:
`done`, `denied`, `timeout`, `not-granted`. Never a URI, a key, a name, a handle or the `source` (a source rule; the log's
own sanitizing, W1a's, as the second layer).

## 4. Where a proposal's keys wait before the user confirms (for the reviewer)

An `accounts.add` carries the keys of the accounts it proposes. Between its arrival and the user's Add (or its end), they
are here, and only here:

- **The worker's memory**, while it reads the request (`readAdd`), for the length of one message.
- **`chrome.storage.session`**, key `sk_plugin_pending` (`core/plugins/pending.ts`; the store is built in one place,
  `platform/plugins/chrome.ts pendingStore`, over `chrome.storage.session` and its own Web Lock; a source rule holds both):
  - **Memory only**, cleared when the browser closes or the extension reloads; **closed to content scripts**
    (`TRUSTED_CONTEXTS`, set at every worker start, the first two calls: `sw-order.mjs`); never `chrome.storage.local`
    (a test reads the whole of `storage.local` while one waits, in the unit tests and in the real browser); never synced,
    backed up, exported, logged, or sent back to any plugin.
  - **What is stored**: the parsed account (type, issuer, label, the canonical base32 key, algorithm, digits, period,
    counter), never the URI as sent; read back strictly (`proposal.ts parseProposal`: a key that is not canonical base32
    of at most 512 characters, a name that is not plain text, an extra field, a place out of range: not a proposal).
  - **How many**: one per plugin (`busy`), **eight** in all (`rate`), at most 200 accounts each (the schema).
  - **How long**: **5 minutes** (`PENDING_MS`, §10.8); then swept and its plugin told `timeout` (an alarm at the first
    proposal's end, and every start of the worker). One being decided (claimed within 30 s) is not swept from under the
    decision.
  - **Only while Sixkey is unlocked**, and **voided at every lock**: the worker reads the lock epoch (`sk_lock_epoch`,
    which every lock moves: `platform/session.ts RoutedSession.clear`), then the session's key (`grantKeys`: none while
    locked, and none ever in "lock every time" mode, where the key is only in the open page's memory), and keeps the
    proposal whole only with a key; it reads the epoch again after the write, and voids it at once if a lock came in
    between. Every proposal is bound to its epoch: **the worker voids every proposal of another epoch at every lock**
    (`watchPending`: storage.session's `onChanged` on `sk_lock_epoch`, a listener added at the worker's top level, so
    the change wakes it), and at every start; and **every reader treats one of another epoch as voided** whatever is
    stored (`showable`, `claim`), so a void that could not be written still never shows. A voided proposal keeps only its
    ticket, its plugin, its type and its times, so that its plugin is told `timeout` at its time, as for a proposal the
    user never opened: the answer and its timing tell nothing of the lock.
- **The surface's memory**: the popup's or side panel's plugin view holds the proposals as stored (W2B-04: they ride on
  its read of the hellos), so a page that is open while one waits has its keys in memory, as it has the decrypted vault;
  and the change list's rows while it is drawn, and during the write.
- **Then the vault**, encrypted as every account is, if the user adds it; else nowhere.

**What is not done, and why.** The keys are not encrypted inside `storage.session`: the vault key itself waits in the same
area while Sixkey is unlocked (`sk_session`), so a key derived from it would add nothing against a reader of that area,
and the proposal must not outlive the unlock in any form (it does not). An ephemeral key in the worker's memory alone
would lose every proposal to a worker restart (MV3 stops an idle worker in 30 s, and a user may take minutes).

**Residuals, stated.**

- Code running in one of Sixkey's own trusted contexts can read a proposal while it waits, as it can the session's vault
  key; a content script cannot.
- A proposal kept in the moment between a lock and the worker's void is unreadable as a proposal (another epoch) but
  physically present until the void (milliseconds; the next worker start or proposal voids it otherwise).
- "Lock every time" mode: the worker never holds the key, so every proposal is voided at once and ends `timeout`; P2
  cannot be used in that mode (as P1 cannot: W2a §3). Kept so: OWNER-DECISIONS/19 Q2 (a), decided 2026-10-30 as
  recommended (§10).

## 5. The W2a leftovers

- **R3-01: a set-aside cut short beside an earlier review list lost the old record's plugins** (`REVIEW-r3.md`). Fixed as
  the review's option 1: `GrantStore.write()`, when the record does not verify, keeps it as it is if nothing is kept yet,
  and otherwise merges its plugins into the kept list (by plugin ID, the newer entry first), so every "second failure"
  keeps both. Tests: `plugins-w2a-r3.test.ts` "W2b, the r3 review's R3-01" (the first run and Start over, the merge into
  the kept list failing: the first tagged write merges, OTHER and PID both for review; and a later failed record merged,
  never in its place). W2a's §12 sentence "Nothing is lost either way" is now true, and says so. Mutant M56.
- **R3-02: the runtime's hook must not pass `cleanupPending`.** A source rule (`plugins-w2b-source-rules.test.ts`):
  runtime-base's `newVault` hook calls `g.newVault({vk: current, activeVkId})` and names no `cleanupPending`; and a
  behaviour test that `GrantStore.newVault` drops a `cleanupPending` it is given (a record beside Start over's marker is
  set aside, not refused), so the review's Q07 is now killed too. Mutants M57, M58.
- **R3-03: Q09 killed by an assertion.** The fault-injection tests assert the vault's making (`"made"`, else
  `threw: …`), so a hook whose error escapes fails an assertion. Mutant M59.
- **W2A-11: the input delay on `add.sources`.** `AddSources` passes `delayed` to `Entries`, which already arms the delay
  again on _More plugins…_ (`rearm`, W2A-03). W1's e2e that clicked such an entry at once now waits 700 ms
  (`plugins.spec.ts`, changed on purpose). Mutant M48; the e2e checks a click inside the delay is not taken.

## 6. Changes to the specification (code wins)

Every change, in `docs/sdk/SIXKEY-PLUGIN-SDK.md` (revision 1.0-draft.11):

| § | Was | Now (and why) |
| --- | --- | --- |
| header, table | 1.0-draft.10 | 1.0-draft.11, wave 2b, pointing here |
| 6.2 registry | add, update, trash: W2; sites.propose: W2 | W2b; sites.propose: later (official only, no official plugin uses it; MOD-PLATFORM's W2 row names add, update and trash only) |
| 6.3 P2 | (the what) | "P2, W2b as built": who, the answer, reading add with the popup's rules, the names as drawn, the duplicates' kinds and counts, never a replace, update's fields and `null` group, trash never erased, where it waits, the decision checked again (r2: marked as being written, the key of the check); r2: one ticket, one result, and its residual |
| 6.4 item 8 | (none) | W2b as built: the window per slot (an account's: every handle that account), the popup opened only with no surface open, never a tab; the badge shared with sync's, the Review line; the spacing counted at the window's use, `busy`, the pause; the delay with the ticks and the focus (r2: and when anything around the list comes or goes); r2: the list as the page's top layer (over every sheet, the rest inert, the focus on it, Tab kept in it, Escape its own); item 5 as built (r2): the list stays up and says why; locked keeps nothing, a lock voids, `timeout` at its time, no lock screen opened |
| 6.6 item 6 | a later failure keeps the first record only | W2b R3-01: merged into what is kept |
| 7.3 item 9 | account slots' entries delayed | and `add.sources`'s (W2A-11) |
| 9.3 | P1 apart with item 4's line | W2b: P2 under Sensitive too; item 4's line with P1 or P3 only; the row marked with every sensitive capability |
| 9.7 | the mark, "Erase old items" | W2b: recorded in the grant entry; the Trash's display later |
| 10.3 | (the schema) | W2b: an update naming one handle twice is `invalid` |
| 10.5 | (tickets, 5 minutes) | W2b: what `request.done` carries for P2, when `timeout` and `not-granted` come |
| 10.6 | (P2: pendingResult in the table) | W2b: P2 at step 6 is `pendingResult`; steps 7 and 8 at the change list; r2: the answer sent before the window, the alarm and the badge, and the timing as measured (the medians about 1 ms apart, the single answers overlapping widely), with how it was measured |
| 10.10 | (no P2) | W2b: the immediate outcome, and the end as a second line; never content |
| 11.1 | OFFERED (W2a), client without P2, the fake of 1 and 2a | OFFERED (W2b), OFFERED_W2A; `addAccounts`, `updateAccounts`, `trashAccounts`, `done`; the fake's `proposals`, `accept`, `deny`, `expire` (r2: `standings`, its add list as Sixkey's, `accept` throwing for a place the list cannot tick; `text.ts displayText`); the P2 cross checks |
| 11.2 | the import plugin with W2b | `otp-import/`, store ID only, an e2e copy under a test key |
| 11.3 | (P1) | P2's e2e |
| 12.4 | (the flow) | as built: `otp-import` |
| 13 | (no P2 rows) | a proposal's keys while it waits; a change list written over |
| 14 | (P1) | what P2 hands over |
| 16.1 | (P2: pendingResult) | the same bytes locked; locked keeps nothing; nothing without the user's click in the popup or side panel, checked again; never in a tab or on the lock screen; add, update and trash's limits |

Appendix A is unchanged (`contract/plugin-sdk/1/` is still Appendix A verbatim): `accountsAddRequest`, `addResult`,
`requestDone` and the rest were right; the update's distinct handles cannot be said in JSON Schema, so §10.3 says it.
Appendix B is unchanged: its P2 lines are the approval screen's words; the waiting badge's title is Appendix B's.

The SDK package follows (version 1.0.0-draft.11): `OFFERED` with P2, `OFFERED_W2A`; `types.ts` with `PendingResult`,
`AddResult`, `UpdateResult`, `TrashResult`, `RequestDone`; the client's P2 helpers, `done()`, `request.done` by message
only and well-formed, and §10.3's pairing check (a P2 answer of `waiting`, or a success that is not a ticket, is no
answer); the envelope's update rule; the fake's P2 (a ticket in every state, `busy`, voided by `lock()`, the user's
`accept`/`deny`/`expire`, Sixkey's reading of a URI, `fakeOtpauth`, and its duplicates and names; r2: `standings`, the
names as `displayText` keeps them, the keys compared by their bytes, `accept` throwing for a place Sixkey's list cannot
tick, and `displayText` and `keyBytes` exported). Its README says so. `docs/sdk/GETTING-STARTED.md` has a §9 on P2. The
revision stays 1.0-draft.11 in r2: W2b's, which r1 never released (r2 corrects it where the code moved, as §11 says).

## 7. Deviations and decisions, with reasons

- **Decided here, conservative and low-friction:**
  - **No proposal survives a lock**, and none is kept from one that comes while locked (the brief: 锁定时清掉). The
    spec's §6.4 item 7 ("the surface that opens shows the lock screen first") is not built for P2: the proposal could not
    be shown after the unlock anyway. Cost: an import begun just before an auto-lock, and every P2 in "lock every time"
    mode, end `timeout`; the plugin can propose again.
  - **All or nothing for an update and a trash**: no per-row ticks (the user can Cancel); an add has ticks, which its
    duplicates need.
  - **A conflict writes nothing at all**, and the list is drawn again with the changed accounts left out, rather than
    writing the others: the user confirms exactly what is written.
  - **An update naming one handle twice is `invalid`**, beyond the schema (§10.3), rather than applying one over the
    other.
  - **`not-granted` for every "no longer may"** (turned off, removed, paused, its record's tag failing, P2 taken away),
    in `request.done`: the plugin learns as little as §10.6's step 7 would tell it.
  - **The global cap (eight proposals) answers `rate`** with `retryAfterMs` 60,000: the error that says "over a limit"
    (it tells a plugin that others are waiting only when eight are, which a user would hardly see).
  - **The waiting mark wins the badge** over sync's count for at most 5 minutes; both are kept (`platform/badge.ts`).
  - **The badge's title is the full catalogs' key** `pxBadgeWaiting` (Chrome's `_locales`, in no page's catalog).
  - **A Review line rather than a link**: the popup's quiet-line style, one line per waiting plugin.
  - **The change list over an account's edit sheet, the sheet kept** (r2, W2B-02): rather than closing the sheet (and
    losing what the user typed), the list is drawn over it as the page's top layer; Escape hides the list first (the
    top), and the next Escape closes the sheet. After an update the sheet shows the plugin's names in every field the
    user has not touched, keeps what the user typed in the others, and its Save writes only the fields the user changed
    (r3, R2-02: before it, Save wrote the old names back); after a trash the sheet goes with its account.
  - **A list whose proposal ended stays up and says why** (r2, W2B-06), with _Close_ only.
  - **A decision whose page closed between the write and its end ends `timeout`** (r2, W2B-01), not `ok`: the claim's
    holder is gone, and nothing else may say what it did; never a false `denied`.
  - **The import sample asks for no Chrome permission** and talks to Sixkey's store ID only (one file, `src/sixkey.ts`,
    the developer's to change); its e2e copy is listed in `plugins/catalog.test.json` under a public test key (the e2e
    and developer builds' `externally_connectable.ids` gain its ID; the store catalog stays empty).
  - **The reader fixture grew P2** (and an `add.sources` entry), its ceiling and pin changed together; the hello plugin
    stays P0. W2a's e2e expectations of the reader's `granted` changed with it (on purpose).
- **Not built, with reasons:**
  - **`sites.propose`**: official only in version 1, and no official plugin exists that would use it; MOD-PLATFORM's W2
    row names add, update and trash only. It stays `not-granted` and unoffered.
  - **The Trash's _Moved to the trash by <plugin>_ and "Erase old items" listing them apart** (§9.7): the IDs are
    recorded (§3.8), but drawing them needs the settings page's Trash to load the platform's view and a word in a
    settings catalog; with 205 B left of a vault's page and 165 B of the settings parts, it is left for a wave of its own
    (an owner item: whether it is wanted at all). (2026-10-29: decided, OWNER-DECISIONS/19 Q3 (b), draw it now; budget
    work 3 draws the mark, its words settled 2026-10-30; "Erase old items" still lists them together: BUDGET3-NOTES.md
    §4.)

## 8. Tests and mutants

**Unit, new** (as of r2: 94 tests in five new files; 112 with those added to existing files; r1 had 73 and 86):

| File | Tests | What |
| --- | --- | --- |
| `plugins-w2b.test.ts` | 32 | P2 in the order of checks (offered; a ticket for listed and official; never on a port, unlisted, P0, P1, beyond the ceiling, paused, off, suspended, unapproved, without a sink; strict bodies before anything is kept; busy and full; the rate; the answer's independence of the lock); reading (the URI rules, the limits, the names as drawn; strict reading back); the add list (the five standings, the defaults, the Add never over another, a row that may not be added, a conflict, the result); the update and the trash (handles per plugin and key, old → new, nothing else changed, conflicts on every kind of change, the trash restorable); where a proposal waits (busy, full, sweep, showable, voidAt, the claim, the spacing, the denials, strict reading, storage.session only) |
| `plugins-w2b-platform.test.ts` | 32 | over a fake `chrome`: the worker keeps it whole in storage.session only when unlocked, bound to the epoch; locked keeps nothing; a lock between voids it; the watch voids at every lock and clears the badge; `timeout` at its time with nothing in the message or the log; the alarm ending them before it is armed again; in front only within the window (add.sources; an account's for that account only; popup.menu nothing), once, spaced; no popup over an open surface; busy; the badge shared; `isSurface`; the decision: Add, its result and handles; turned off, removed, paused, a failed tag, P2 taken away: nothing written, `not-granted`; locked and another epoch: nothing; claimed elsewhere: nothing; a conflict, then decidable again; a handle of another key; the trash and its marks; three denials pause |
| `plugins-w2b-dom.test.ts` | 14 | the change list: who proposes it, the source, the standings, the refused; every plugin string through displayText; Add's 600 ms and its untrusted click; the ticks' delay; a conflict drawn again with the delay armed again; Don't add; gone; an update's and a trash's rows; the approval screen with P2 (no internet line) and with P1 |
| `plugins-w2b-source-rules.test.ts` | 13 | the store over storage.session in one place, nothing of P2 in storage.local or a log; the worker's order (the lock, the key, the lock again); one write through mutate; addEntry, editEntry (names), setGroup, deleteEntry only; the decision's order; Requests in Main's two views only, isSurface first; the change list's text in its view alone; its delay, its trusted click, its provenance; W2A-11; R3-02 (the hook, and the store's drop); the badge shared |
| `sample-otp-import.test.ts` | 3 | the sample's reading of a file; its flow against fakeSixkey |
| `plugins-w2a-r3.test.ts` | +4 | R3-01 (both ways to a new vault; a later failed record merged); R3-03 in the fault tests |
| `plugin-sdk-cross.test.ts` | +4 | P2 across its world (9,600 runs: the fake against Sixkey's dispatch, and Sixkey locked or not the same); an Add's result against Sixkey's reading (300 random runs, every standing seen) |
| `plugin-sdk-client.test.ts` | +7 | addAccounts and done through the fake (locked: a ticket, voided, `timeout`; busy; the result and its handles; done after the result); update, trash, deny, not-granted, an update naming one account twice refused; W-5's pairing and request.done's checks; request.done on a port dropped; done's own timeout |
| `check-dist-plugin-pages.test.ts` | +3 | the change list's text named elsewhere, reached from the settings page, its view static |

**Unit, changed on purpose:** `plugins-core` and `plugins-protocol` (the example of a capability not offered is P3's
`codes.read` now, P2 being offered; sites.propose as the listed plugin's unreachable one), `plugins-source-rules` (the
worker wired with P2; Main's one session read of two keys; ChangeList.tsx in the platform), `plugins-w2a-source-rules`
(the row's mark; the reader's ceiling), `plugins-w2a-dom` (SENSITIVE, the popup catalog's new key), `budget-split` (the
new catalog and its budget, the badge's key), `plugin-sdk-package` (the third sample), `check-dist-plugin-pages` (the
third kind). And the worker's existing tests, for its two new wirings: `autofill-pre-source-rules` (the alarm name
`sk-plugin-pending`; `platform/plugins/chrome.ts` among the files that send by `runtime.sendMessage`, an event to a plugin as
`invoke.ts`'s; the two new `storage.session.onChanged` listeners, each held to its shape: key names only, never a value),
and the fakes of `chrome.storage.session` in `test/helpers/sw-world.ts`, `m5-permission-handlers`, `m5-sw-locks`,
`m5-sw-wiring` and `quick-sw-alarm` (an `onChanged`, which the real area has). The worker keeps one alarm listener: the
proposals' alarm is a line in it (`pendingAlarm`), so `m5-sw-wiring`'s and `autofill-pre-storage`'s listener counts are
unchanged. **e2e, changed on purpose:** `plugins-w2a.spec.ts` (the reader's `granted` with P2), `plugins.spec.ts`
(W2A-11's delay).

**e2e, new:** `plugins-w2b.spec.ts`, five tests in a driven profile: (1) P2 approved apart; an add after the reader's
add.sources click in front in the real side panel; its provenance, standings and refused count; its keys in
storage.session and never in storage.local; Add's delay; the result and its handle the same as `accounts.list`'s; the
log without content; (2) the toolbar popup closed when the plugin proposes: Sixkey opens it for the list, once; (3) an
update outside the window: the Review line and the badge, `busy`, old → new, Apply, the badge back; a trash, restorable in
Settings; three denials pausing the plugin; (4) locked: a ticket, nothing of it kept, no list on the lock screen or after
the unlock; a P0 plugin refused; (5) the import sample's whole flow: its window reading a file, Sixkey's change list in
the side panel, the result in its window. And since r2 `plugins-w2b-r2.spec.ts`, nine tests: the review's probes kept
(§11).

**Mutants** (`tools/w2b-mutants.py`, copies in the snapshot folder): 69 hand-made, one idea each, each killed by an
`AssertionError` of the named tests (the runner refuses a kill by any other error): who gets P2 (M01 to M12), never losing
or writing over (M13 to M27), the claim (M28, M29), the keys at rest (M30 to M40), the change list (M41 to M48), the
window, the spacing and the denials (M49 to M55), R3-01 to R3-03 (M56 to M59), the badge (M60), the SDK's mirror (M61 to
M65), the catalog rule (M66, M67), the proposals' time limit from the worker's alarm (M68, M69). The first run killed 63:
two died of a `TypeError` or an unhandled rejection beside their assertions (M38, M41: the tests now assert first), and
two survived (M40: the log rule did not see a call written `{…} as never`, now it counts every call; M60: `badge.now()`
repeated the drawing's logic, now both are one function, and the badge's calls are checked too). Then 67 of 67, and with
M68 and M69, 69 of 69.

**Runs, all on the delivered tree** (logs in `scratchpad/w2b/`): the gates (messages.py,
typecheck of both projects, the prod, e2e and developer builds with their check-dist, format:check, notices:check); the
full unit run, 283 files, 4,265 passed, 4 expected to fail, 1 skipped (the base: 278 files, 4,178 passed); the full e2e
run (port 18815), 406 passed, 1 skipped, none flaky, `perf.spec` among them; e2e:sync, 12 passed; the mutants, 69 of 69.
The first full unit run found 65 failures in ten of the worker's existing test files (the fakes without
`storage.session.onChanged`, a second alarm listener, three source-rule lists), all fixed as said above; the second
passed whole.

## 9. The brief's hard requirements (KW-2)

- **No data lost, none written over, the change list never skipped.**
  - Add never writes over an account: `applyAdd` uses `addEntry` with new IDs only, and refuses a row that may not be
    added (M13); duplicates are marked and unticked by default, an account already there or repeated never addable (M22,
    M23); tests: the add list, the Add, the e2e's standings.
  - Update changes the name, the issuer and the group only: `editEntry` with those two fields and `setGroup`; the schema
    and Sixkey's body rule refuse any other field (M18, M19, M21, M27); tests: "changes nothing else of the account".
  - Trash moves to the trash only, restorable, never erased: `deleteEntry` (M20); tests: restored with its key; the e2e
    finds it in Settings › Trash.
  - Nothing is written without the user's click in the list: the only write is `accept`'s `mutate` (a source rule).
- **Checked again at the decision, as `invokeOnAccount`:** the verified record (approved now, P2 held, the tag): M04 to
  M09, and with a fresh key (Q07); the handle still naming the same account under the key that check read: M24; an
  account changed since drawn: a conflict, nothing written: M14 to M17, Q11, Q12; the claim: M07, M28, M29, Q05, Q09;
  one ticket, one result (r2): M70 to M75, M95, Q01 to Q04. Each with its test above.
- **The keys of a proposal:** never in an answer, an event, a log line (M39, M40; tests read the messages and the log);
  checked (base32, lengths: M25; the names as drawn: M26; strict reading back); while waiting never in `storage.local`,
  only `storage.session` (M38), capped (M36, M37), timed (M35, M68, M69), voided at lock (M30 to M34). §4.
- **The change list only while Sixkey is open** (its popup or side panel, `surfaceOpen` reused, never a tab: M11, M12; and drawn only for a plugin that still holds
  it: M10);
  every plugin string through `displayText` (M46); its delay (M41, M43, M44, M82) and the user's own click (M42); the
  provenance always (M45, M94); the page's top layer, the rest inert, the focus on it, Escape its own, Tab kept (r2:
  M79 to M83, and `plugins-w2b-r2.spec.ts` in the real browser); never on the lock, PIN, password or export screens
  (M47; the platform's screens rule).
- **The ordinary vault write path**, as the user's own edits (`service.mutate`, sync's outbox after it); the grant
  store's tagged writes through `withFreshKeys` (the decision's read, whose `StaleKeyError` it retries: Q07; the trash
  marks, whose `CleanupPendingError` runs W2a's `runPendingCleanup` once and tries once more, else the diagnostics log:
  M88, M89). The decision's read can never meet a pending clean-up (r2 dropped the branch that said _try again_).
- **No new Chrome permission:** the store build's manifest is byte for byte the base's (gates log); `action.openPopup`,
  `tabs.getCurrent`, `runtime.getContexts` and `storage.session` need none; the e2e and developer manifests differ only by
  the import sample's test ID in `externally_connectable.ids`, which the test catalog generates. Unknown senders:
  unchanged.
- **No new `chrome.storage` read at the popup's open** (r2, W2B-04; r1 broke it with a plugin approved): Main's one
  session read asks two keys in one call; the proposals and the lock epoch ride on the plugin view's read of the hellos;
  `Requests` reads afresh only when the proposals change. Held in the real browser by `plugins-w2b-r2.spec.ts` (every
  `get` of both areas counted at each open of the side panel and the toolbar popup, a plugin approved, a proposal
  waiting or none: the base's 10 and 7, 11 and 10), by source rules (M77, M78), and by `perf.spec` (no plugin).
- **Sizes:** no limit raised; the change list's text in its own catalog, loaded by its view alone, proven by
  reachability in check-dist and held by a test; the numbers in §2.
- **Limits** (§10.8): 200, 100 and 100 items, the string lengths, three a minute of each type, one waiting per plugin,
  eight in all: `invalid`, `rate` or `busy`, the vault untouched (tests in `plugins-w2b.test.ts`).
- **Who never gets P2**: unlisted (M01, M03), P0 or P1 only (M02), locked (M30 to M34, and the decision's lock and
  epoch: M07), paused (M04), a failed tag (M05), revoked (M06, M08, M09); answered as §10.6 says, no more.

## 10. Owner items (none blocks the merge; defaults as built)

- **The words**, drafts for the store copy and the data-transfer wording (OWNER-DECISIONS/06, 14 OQ3): the three P2
  approval lines (Appendix B's), the change list's words (`scripts/i18n/w2b.py`), _A plugin is waiting for your answer_,
  _<plugin> is waiting for your answer_, and PRIVACY.md's new paragraph on P2.
- **P2 in "lock every time" mode**: never (every proposal ends `timeout`), as P1 is never there; the responder of §3.3
  item 6 would close both. Decided (OWNER-DECISIONS/19 Q2 (a), 2026-10-30, as recommended): kept so, no responder.
- **The Trash's marks** (§9.7): build them, or drop them from the spec. Meanwhile Settings › Trash's "Erase old items"
  lists the accounts a plugin moved there together with the user's own (the review's note): whether that is acceptable
  until the marks are drawn. Decided (OWNER-DECISIONS/19 Q3 (b), 2026-10-29): built in budget work 3, the mark beside
  each such account in the Trash (BUDGET3-NOTES.md §4; its words settled 2026-10-30, §7 there); "Erase old items" still
  takes them with the user's own, not listed apart (SDK §9.7).
- **A decision cut short by its page closing** (r2, §3.6's residual): the plugin is told `timeout` though the change was
  made. Acceptable, or a later wave lets the worker finish such a proposal from the vault (it does not hold the vault).
- **The import sample**: as a repository sample (Q-A (ii)); its licence as the other samples', Apache-2.0
  (OWNER-DECISIONS/18 Q1, decided 2026-10-30 as recommended).
- **OWNER-CHECKLIST 47 and 48**: a read of what the e2e checks for P2, and of the sample.
- **From W2a, both decided 2026-10-30 as recommended:** a developer mode for plugins added by ID (OWNER-DECISIONS/19
  Q1 (a): none in the store build; the developer build's own list instead, implemented: `DEVREAD-NOTES.md`); the "lock
  every time" responder (OWNER-DECISIONS/19 Q2 (a): not built; P1 stays `unavailable` and P2 ends `timeout` in that
  mode).

## 11. r2: the independent review's findings (`REVIEW.md`, 2026-10-27)

The review's verdict was "修改后通过", KW-2 not triggered; six findings to fix (W2B-01 to W2B-05, W2B-10) and four
suggestions (W2B-06 to W2B-09), all done here. Its probes (`REVIEW-probes-src/`) are kept as regression tests where they
found something, its 37 mutants (`REVIEW-tools/review-mutants.py`, Q01 to Q37) run with this patch's own by one runner
(`tools/w2b-mutants-r2.py`).

| Finding | What it was | The fix | Held by |
| --- | --- | --- | --- |
| **W2B-01** one ticket, one result | `deny` and `endWith` ended a proposal another surface was writing (RP-U1, RP-U3: `["denied","ok"]`); a page gone between the write and the end left it to be drawn again and denied (RP-U5) | every end takes the claim first; `finish`, `release` and `writing` take the claim; `writing` marked before the write, never drawn or claimed again, `timeout` at its time; `bare()` keeps the claim and the mark through a lock's void (§3.6) | `plugins-w2b-platform.test.ts` RP-U1, RP-U3, RP-U5, Q01/Q02; `plugins-w2b.test.ts` "W2B-01"; DOM: a Don't add another surface beat; M70 to M75, M86, M95, Q01 to Q04 |
| **W2B-02** under the edit sheet | an update or a trash put in front from an account's edit sheet was drawn under it; uncovered, it took a click at once (RE-9: trashed); Escape went to the list (RE-11); a double click on Save (RE-10) | the list is the page's top layer (z-index 20, the rest inert, any element added meanwhile too); the delay armed again whenever an element comes or goes around it; Escape its own, in the capture phase; Main no longer closes the sheet | `plugins-w2b-r2.spec.ts` RE-8/RE-9 (update and trash), RE-10 (both), RE-11; DOM "the page's top layer"; M79, M81, M82, M87 |
| **W2B-03** the focus | the focus stayed on the plugin's entry under the list: Enter and Space pressed it again (RE-6: 11 `slot.invoked`); Tab left the list | the focus on the list's container (`tabindex="-1"`, neither button), the rest inert, Tab and Shift+Tab kept within the list's controls, the focus given back when it goes | `plugins-w2b-r2.spec.ts` RE-6 (5 Enter, 5 Space: still 1 `slot.invoked`; no Tab stop on the page); DOM; M80, M83 |
| **W2B-04** reads at an open | with a plugin approved, `Requests` read the view afresh and the store at every open: side panel 10 → 15 and 7 → 14, popup 11 → 16 and 10 → 17 | the proposals and the lock epoch read with the hellos (one get); `Requests` uses the page's shared view at the open, fresh only on a change (§3.5); the lock's key spelled in the view, not imported (importing it moved the session's code between the popup's static chunks: +630 B gz measured, gone) | `plugins-w2b-r2.spec.ts` RR: exactly 10 and 7, 11 and 10, a proposal waiting or none; source rules; M77, M78 |
| **W2B-05** the fake | it added an account Sixkey cannot tick (RP-F1), kept the names as written (RP-F2), compared keys as written (RP-F3) | `standings()` by Sixkey's rules; `accept` throws for a place the list cannot tick (the proposal still waits); the names through the SDK's `displayText` (the same function as Sixkey's, held equal), the keys by their bytes (`keyBytes`, held equal to Sixkey's); an update's names likewise | `plugin-sdk-cross.test.ts` RP-F1 to RP-F3, `displayText` and `keyBytes` against Sixkey's (3,000 runs each), the Add property now also comparing standings and kept names (300 runs, new key spellings and names); `plugin-sdk-client.test.ts`; M90 to M93, Q31 to Q33 |
| **W2B-06** the list's last word | an end meanwhile (another surface, the time up, the plugin turned off) unmounted the list before its line showed (RE-2, RE-3) | the list stays up until closed, says _This was already answered, or it expired._ when its proposal leaves the store, unless its own answer already said what it came to; who proposed it is kept while it is up | `plugins-w2b-r2.spec.ts` RE-2 (the line in the real browser, still there a second later) and "ended elsewhere"; DOM; M84, M85, M94 |
| **W2B-07** the timing | the window, the popup and the badge were done before the answer: unlocked median 8.7 ms, locked 6.2 | the answer first; the rest after it (`follow`, not awaited) | measured again with the review's RE-7 (§10.6 of the spec now says the numbers and how): unlocked 6.9 and 7.0 ms, locked 6.0 and 5.8 ms; source rule; M76 |
| **W2B-08** `CleanupPendingError` | the decision's branch for it could never be reached; the trash marks swallowed it | the branch and its word dropped (the decision's read cannot meet it: §3.6); the marks run `runPendingCleanup` once and try again, else the diagnostics log | `plugins-w2b-platform.test.ts` "W2B-08" (both ways); `plugins-w2a-source-rules.test.ts`; M88, M89 |
| **W2B-09** small errors | the sample's comment (`storage`), check-dist's 651 B, "the key held now", PRIVACY's "nothing if you say no" | corrected: no permission at all; 741 B; the key the check read (§3.6 item 3); "only that you said no" | — |
| **W2B-10** 16 survivors | Q01, Q02, Q08, Q12, Q13, Q17, Q19 to Q25, Q30, Q31, Q33 survived the tests; Q07, Q14, Q27 only by source rules | a behaviour assertion for each: Q01/Q02 (an end afterwards sends nothing), Q07 (a stale key at the decision tried again), Q08 (no entry, no list), Q12 (an Apply after a conflict writes only what was kept), Q13 (a group-only change written), Q14 (a second Cancel while one is answered), Q17 (a stored field Sixkey never writes), Q19 to Q21 (a voided proposal busy, counted, swept at its time), Q22 (it ends `timeout`), Q23 (the review's RP-K2), Q24 (the old one told `timeout` at the next proposal), Q25 (the alarm at the first one's end), Q27 (the line for none but the showable: the source rule, and the e2e), Q30 (the newer entry kept), Q31 (no accept after a void and an unlock), Q33 (done waits for its own ticket) | the tests named; the runner below |

**Mutants after r2** (`tools/w2b-mutants-r2.py`, the snapshot folder's copy): 132 in one run, on the delivered tree,
each required to fail on an `AssertionError` (fast-check's "Property failed", caused by one, counts as one): the 69 of
§8 (six anchors ported where r2 changed the code, the idea kept: M06, M07, M10, M28, M31, M34), 26 of r2's own (M70 to
M95), and the review's 37 (eleven anchors ported likewise: Q01 to Q06, Q09, Q17, Q21, Q27, Q32; the rest as the review
wrote them). All 132 killed by assertions. The first run killed 128; four failed otherwise: M29 dereferenced the null it made
(ported: the claim and the mark both skipped, as the idea is), M38 and M84 met a `TypeError` beside their assertions (the
tests assert first now), and Q32 was killed by a fast-check property whose cause the runner did not read (it reads
`Caused by:` now). Then those four, and the whole run again on the delivered tree: 132 of 132.

**Runs after r2, all on the delivered tree** (logs in `scratchpad/w2b/logs/`, `*-r2*`): the
gates (messages.py, typecheck of both projects, the prod, e2e and developer builds with their check-dist,
format:check, notices:check; the store manifest byte for byte the base's); the full unit run, 283 files, 4,291 passed,
4 expected to fail, 1 skipped (r1: 4,265); the full e2e run (port 18815), 415 passed, 1 skipped, none flaky
(`perf.spec`, `plugins-w2b.spec.ts`'s 5 and `plugins-w2b-r2.spec.ts`'s 9 among them; r1: 406); e2e:sync, 12 passed;
the mutants, 132 of 132; the review's RE-7 timing probe twice (§10.6 of the spec). The budgets in §2.

## 12. r3: the r2 review's findings (`REVIEW-r2.md`, 2026-10-27)

The r2 review's verdict was "修改后通过": r1's six findings verified fixed; three to fix (R2-01 to R2-03) and one
suggestion the maintainers made a must (R2-05); R2-04 not done (§3.6's residual says why it is safe); and RE-2b, an older
issue, looked into and fixed, as it was small.

| Finding | What it was | The fix | Held by |
| --- | --- | --- | --- |
| **R2-01** a conflict said as "answered" | In the real browser a conflict always ended as _This was already answered, or it expired._, Close only (RE-4b, 3 of 3), though the proposal still waited: the read its own `writing` mark set off came back after the conflict and read "not showable" as "ended" | the one in front has ended only when it is gone from the store, or not showable for another reason than its decision being written (`pending.ts endedFor`); `Requests` draws only the latest read it started, never an earlier slower one | `plugins-w2b.test.ts` "R2-01" (`endedFor`); DOM "R2-01" (an end heard while its own Apply is under way is not said, the conflict then is, the list drawn again; this kills the review's N13, `busyNow`'s guard); e2e RE-4b twice in a row (the line still there 1.5 s later, the row marked, Apply there, the store's proposal neither claimed nor being written); M96, M98, M100; e2e emR201 |
| **R2-02** the sheet's old values | after Apply over an account's edit sheet, its fields still showed the old names, and its Save wrote them back, undoing the rename (RE-13) | both, the simplest pair that is also sure: the sheet takes the change into every field the user has not touched (each against the field's value now: the first try compared a render's closure, and the e2e caught it losing a typed key), and Save writes only the fields the user changed (`edit-save.ts editSaved`: the sheet hands Main the edit to make, and Main makes it), which holds also in the moment before a change reaches the sheet. A field the user changed keeps their text, which is what Save writes: their choice, on screen. So no new words were needed | `plugins-w2b.test.ts` "R2-02" (`editSaved`: the applied rename and regroup stay, the user's field lands, nothing changed is nothing written); e2e RE-13 in "W2B-02 (RE-8, RE-9) accounts.update" (the untouched field shows the applied name; Save: the user's issuer and the plugin's label); M99, M101; e2e emR202b |
| **R2-03** the layer untested | with the list's z-index set back to 6 every W2B-02 e2e passed: `inert` takes the sheet out of `elementFromPoint`'s hit test, so `topAt` saw the list under a sheet painted over it | the review's RE-16 kept: `paintedAt` lifts the page's inert marks for one look (and puts them back), and the list's computed z-index must be above the sheet's | e2e "W2B-02 (RE-8, RE-9)", both types; e2e emz killed (both tests) |
| **R2-05** two results | a write that outlasted its claim and the proposal's time: the sweep sent `timeout`, then the Add `ok` (RP-R1) | the sweep's rule as W2B-01's: it ends a proposal only once no claim holds it; the Add sends its result only if its `finish` (by its claim) ended the ticket | `plugins-w2b-platform.test.ts` "W2b r3 (… R2-05, its RP-R1)" (the sweep's `timeout` and nothing more; while the claim holds, the sweep leaves it and the Add says `ok`); M97, M103, Q09 |
| **RE-2b** an Off lost | Settings › Plugins' switch, its page closed at once: the plugin still on. Looked into: the switch shows Off at the click (the box's own toggle) while its tagged write (key, lock, verify, seal, write) runs a few milliseconds more, and a page that goes cuts it short. The same code since wave 1a's switch (the base has it as it is): not W2b's | small, so done: the page holds itself while any grant-store write of it is under way (Allow, a row's switch, Remove, Resume, Forget), asking before it is left (`beforeunload`), as the first-run wizard and the key operations do | e2e "r3 (… RE-2b)": the write held back by the vault's lock taken in another of Sixkey's pages, leaving asks, the user stays, the Off lands, then the page closes without asking; source rule; M102; e2e emRE2b |

**R2-04, not done.** The worker's sweep could finish an add whose page closed after its write (its planned IDs in the
mark, the vault read again when unlocked). As the review and the maintainers agreed, it is left out to keep this simple;
§3.6 states the residual and why a retry neither loses nor duplicates anything.

**Mutants after r3.** Unit (`tools/w2b-mutants-r2.py`, made by `make-r2-runner.py`): 140 = the 132 of §11 (Q03's anchor
ported: the Add's `finish` moved) and r3's M96 to M103. e2e (`tools/e2e-mutants-r3.py`, in the real browser, the file
put back each time): emz, emR201, emR202b, emRE2b. All killed by assertions on the final tree: 140 of 140 unit, 4 of 4
e2e (emz by both W2B-02 tests' new paint and layer checks). The field-wise Save's own mutant is unit (M99): in the
browser the field adoption shows the same names first, so only the unit test tells the two apart.

**Runs after r3, all on the delivered tree** (logs in the snapshot folder's `logs/`, `*-r3*`): the gates (messages.py,
typecheck of both projects, the prod, e2e and developer builds with their check-dist, format:check, notices:check; the
store manifest byte for byte the base's); the full unit run, 283 files, 4,296 passed, 4 expected to fail, 1 skipped; the
full e2e run (port 18815), 417 passed, 1 skipped, none flaky (`perf.spec`, `plugins-w2b.spec.ts`'s 5 and
`plugins-w2b-r2.spec.ts`'s 11 among them); e2e:sync, 12 passed; the mutants as above. A first r3 chain found one unit
failure, `sidepanel-check-dist.test.ts` (its fixed pad left no room for the first form's +89 B), which the save's move
to the sheet's lazy code fixed; everything above is from the second chain.
