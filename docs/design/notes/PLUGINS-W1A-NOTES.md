# Plugin platform, wave 1a: the core and P0

The owner's decision (OWNER-DECISIONS/16, 2026-10-23, "都用推荐"): Q-A (a), build the platform in waves, autofill a
built-in official plugin (W1b), the two example tools as samples in the repository (W1c); Q-B "balanced": any plugin may
put buttons in Sixkey (P0), reviewed (listed) ones appear by themselves, others are added by the user (paste an ID, or
"Connect to Sixkey" from the plugin); P1 and P2 for reviewed plugins only (W2); no codes for other people's plugins in
version 1; no developer switch in store builds for W1; optional `management`, asked when the first plugin that is not
official is enabled; a block list shipped with each release. This is wave 1a: the platform's core and P0. The normative
text is `docs/sdk/SIXKEY-PLUGIN-SDK.md` (revision 1.0-draft.5 records what this wave settled, each marked "W1a"); the
reasons are `docs/design/proposals/MOD-PLATFORM.md` v3.1.

## 1. What a plugin can do, and see, in wave 1a

- **Put buttons in three of Sixkey's places**, drawn by Sixkey from the description the user approved: the popup's and
  the side panel's Plugins menu (`popup.menu`), the Add account view's "From plugins" (`add.sources`, official and listed
  plugins only), and its own row in Settings › Plugins (`settings.page`).
- **Hear a click** on one of them: `slot.invoked` with the entry's ID, the slot, the time and, in the popup and the side
  panel, the tab's ID. Nothing else (V-4).
- **Ask `env.get`**: Sixkey's theme, language and version, the same in every lock state.
- **Nothing from the vault.** No account, no name, no code, no handle, no site, and not the lock state. P1 (account
  names), P2 (proposed changes) and P3 (codes) are not offered: a descriptor that asks for them is answered with what it
  could not have in `unavailable`, and the rest works.

## 2. The pieces

| Piece | Where | What |
| --- | --- | --- |
| The rules | `src/core/plugins/` (pure, no `chrome`) | `jcs.ts` (RFC 8785, SHA-256), `text.ts` (plain text, protected terms with a TR39 subset, the `keys` grammar, the PNG limits), `descriptor.ts` (read tolerantly §4.3, negotiate §5.3, the allow-list §4.2, `contributionsHash`), `grants.ts` (the three records, the tag, the transitions, tighten-only), `policy.ts` (the catalog, the trust levels, ceilings, slots, a plugin's state), `protocol.ts` (the order of checks, the sender kinds, the limits, hello and env.get), `store.ts` (reads and writes, the lock, crash order, re-tag), `session.ts` (the session's records), `slots.ts` (what is drawn, the click's body) |
| The browser | `src/platform/plugins/` | `chrome.ts` (the catalog, `management`, the stores), `worker.ts` (the one listener; plugin-opened ports refused), `port.ts` (surface ports to unlisted plugins), `invoke.ts` (a click) |
| The screens | `src/ui/plugins/`, `src/popup/main/Plugins.tsx`, `src/options/Plugins.tsx`, `PluginApproval.tsx`, `PluginsHost.tsx` | the entries and their provenance, the popup's button, menu, "From plugins" and quiet line, Settings › Plugins and its approval screen |
| The catalog | `extension/plugins/catalog.json` (the store: empty), `catalog.test.json` (the e2e and developer builds: the test plugin, listed) | `scripts/build.mjs` puts it in the code (`__PLUGIN_CATALOG__`) and makes `externally_connectable.ids` from it (`scripts/connectable.mjs`: with no official or listed plugin, the reserved ID alone; `EXTERNALLY-CONNECTABLE-NOTES.md`); `scripts/check-dist.mjs` fails on any difference |
| The test plugin | `extension/test/fixtures/plugins/hello/` | MV3, a public test key (ID `mdmdmmfholobdjhebgkejafplfihedco`), P0, one entry per slot; for the tests, and for the owner's check (OWNER-CHECKLIST 37, 38) |

### 2.1 Messaging

- **Static `externally_connectable.ids`**: the store build lists no plugin, and the e2e and developer builds list the
  test plugin. Every other extension is refused by the browser with the error of a missing receiver (PRB M0-9 (b)); the
  e2e suite checks it with the unlisted copy. **Since 2026-10-27** (`EXTERNALLY-CONNECTABLE-NOTES.md`): a store build
  whose catalog lists no official or listed plugin declares `{"ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}`, the
  built-ins' reserved ID (no extension can have it, and the worker drops it), not `{"ids": []}`: Chrome refuses every
  extension in exactly the same way with either, but reported the empty list ("'externally_connectable' specifies
  neither 'matches' nor 'ids'; nothing will be able to connect") when the owner loaded the store build unpacked. Never
  `matches` (no web page), never the key left out (every extension could then connect); `check-dist` holds both shapes
  byte for byte, and `test/e2e/externally-connectable.spec.ts` checks the store build itself in Chromium.
- **Unlisted plugins** are reached through a port a Sixkey page opens (`chrome.runtime.connect(id, {name:
  "sixkey-plugin/1"})`), only when the user opens the plugin's approval screen or clicks its entry; the plugin says hello
  first; the port closes 30 s after its last message or with the page. The worker never opens one (a port does not keep
  a worker alive, PRB M0-9 (c), (e)). On the opener's side the browser gives the port no sender: the plugin is the ID
  Sixkey connected to.
- **One responder** (PRB M0-10): the worker has the only `onMessageExternal` listener, and the only `onConnectExternal`
  (which disconnects at once and logs `port-refused`). No page registers one: wave 1a has no vault request for an
  unlocked page to answer in "lock every time" mode (that is W2's `sk_plugin_responder`).
- **Never pending**: every answer within 1.8 s (`internal` then); a dropped message (§5.4) is left without `return true`.
  Events are sent and never awaited.
- **The order of checks** (§10.6) for every request type of version 1, with the browser's sender fields only; wave 1a
  answers hello and env.get, and every other type ends at `not-granted` or earlier. Rate: 60 a minute per plugin, and the
  per-type limits of §10.8, in memory.
- **Lenient hello**: unknown fields ignored; an unknown or unoffered capability, slot, icon, `when` value, a repeated name
  or ID, or a bad locale entry dropped and listed in `unavailable`; only the top level fails the descriptor. Version
  negotiation reads `sdkVersion`/`sdkMin` first.

### 2.2 The grant store (§6.6)

- **One record**, `sk_plugins` in `storage.local`: `{v, epoch, developerMode, plugins: [{pluginId, state, reason?,
  descriptor, granted, approvedAt, trashed}], tag}`, the tag HMAC-SHA256 under `K_g = HKDF-SHA256(vault key, salt empty,
  "sixkey/v1/plugin-grants", 32)` over the JCS of the rest. It binds every plugin ID, each descriptor and state, the
  grants, `developerMode` (always false: no developer mode in wave 1) and the epoch. Read strictly: anything else is
  damaged. The trust level is never in it.
- **Verified before anything is drawn**, and only with the unlocked key (`ServiceCore.grantKeys()`, the one service method
  the platform uses). Drawing happens only on the unlocked list and in an unlocked settings page; P0's answers (hello,
  env.get) read the record without the tag, so they never depend on the lock.
- **A failed tag never wipes**: the record stays; nothing is drawn; Settings says "Sixkey could not check its plugin
  approvals. Review them."; each plugin can be approved again, from a fresh hello. The first approval starts a new
  record holding only that plugin, and the failed record is kept aside, once (`sk_plugins_unverified`), so its other
  plugins stay listed for review and are never honoured (approving one launders none of the others).
- **Writes without the key go to the overlay**, `sk_plugins_overlay`, which can only suspend, disable or remove. The worker
  never holds the key, so every write it makes is there. An entry counts only if it is newer than the plugin's last
  loosening, and it never lowers a state (approved < disabled < suspended < changed since review). The next verified read
  merges it and re-tags.
- **Rollback**: the epoch of the last record written or verified in this browser session is kept in `storage.session`
  (`sk_plugins_epoch`); an older record is refused. The record is written before the epoch, so a crash never makes the
  store refuse its own record.
- **Key changes** (r2, review F4): a read verifies under the current vault key only. The record is one of the vault's
  key-change records (`VkRecord`, wired in `src/platform/runtime-base.ts`; its code, `GrantStore.reencrypt`, loads only
  when a cleanup runs): the one cleanup entry point re-tags it under the new key right after the change, under the vault
  lock, with the check that the vault's active key is still the new one and that the record is no older than this
  session's epoch (a rollback is left as it is). A damaged record, or one no held key opens, never holds the cleanup's
  marker up. So a retired key can forge an approval only inside that cleanup; a record that misses it asks for a review.
  r1 re-tagged at use, under any of the keyring's up to 64 previous keys, at any time.
- **Pauses after denials** live in `storage.session` (`sk_plugin_pauses`); wave 1a has no request a user can deny, so the
  store and the screens honour and resume them, and nothing writes one yet (W2's cards and change lists will).
- **Never travels**: none of these keys is vault data (`store.ts hasAnyData`), and no sync, backup or export code names
  them (a source rule).

### 2.3 The trust levels

Computed at every use from the bundled catalog and, with `management`, the install type: official and listed IDs that
`management` reports as `development` or `sideload` are unlisted ("Developer copy"). Ceilings: unlisted P0; listed its
catalog ceiling, never codes, badges or sites in version 1; official its catalog's. With `management`, a third-party
plugin that holds more than P0 and whose installed version is not the approved one is suspended (`version-changed`, at
run time); one that holds P0 only is not (OD-2): Settings › Plugins says "Updated to version X since you approved it",
and when Sixkey gets `management` it records the versions Chrome reports as the approved ones. A catalog `minVersion` is
held to the version the plugin has now: Chrome's with `management`, else its latest hello's, else the approved one (F5;
the hello's is the plugin's own word, and P0 is all it can unlock). A listed plugin
is held to its pinned `contributionsHash`, at hello and at every use (a new catalog suspends it until approved again from
a descriptor that matches); a listed plugin whose descriptor does not match cannot be approved at all.

## 3. Settings › Plugins and the approval screen

A sixth group of the rail (`#plugins`, one leaf). Locked, it says "Unlock Sixkey to see and approve plugins." and lists
nothing. Unlocked: the plugins waiting for an approval (official and listed ones that said hello), every approved one with
its badge (Official, Third-party · reviewed, Third-party · not reviewed, Developer copy), its state, its switch, its
`settings.page` entries, its shortcuts as key caps, its recent requests and Remove (and, when an entry was refused for a
protected term, "Some of its buttons are not shown: their names use words only Sixkey may use."); the plugins of a record
whose tag failed, for review; and "Add a plugin" by its ID.

- **"Connect to Sixkey"**: a plugin opens `options/index.html#plugins/add=<its ID>`. The address only chooses the leaf and
  fills the field: it never opens a port, shows the approval screen or writes anything (§9.2, PRB M0-13).
- **The approval screen** (§9.3, Appendix B's P0 words): the name (marked "name given by the plugin" unless the catalog or
  Chrome names it), the badge, the publisher and version; Access to Sixkey, each capability with its reason quoted and the
  buttons it will show; Access in Chrome (Chrome's own warnings with `management`, else that Sixkey cannot see them); the
  line about the `management` prompt when one comes; "Sixkey never gives any plugin your account keys, master password,
  recovery key, PIN, backups or security settings. Plugins have their own windows; Sixkey asks for your password or PIN
  only in its own window." Allow and Don't allow ignore input for 600 ms after the screen appears, after its window gains
  the focus and after the page is shown again, a press that began earlier included; neither has the focus.
- **`management`** (OD-1, narrowed in r3) is asked only in a click that enables a listed (reviewed) plugin (Allow, or
  its switch turned on again), first, while Sixkey does not hold it: a same-key developer copy matters only for a listed
  ID, whose rights it would get (M0-8). A plugin added by its ID never asks; the cost, said in the docs only: its
  approval screen shows no Chrome warnings (it says Sixkey cannot see them), and Settings cannot tell it uninstalled
  from turned off. For a listed plugin Sixkey waits for the answer: a "no" leaves it off and Settings says "Not turned
  on: without permission to manage your extensions, Sixkey cannot check which copy of the plugin this is." The
  permission is given back when no listed plugin that is not turned off is left, and when Chrome's "yes" was followed by
  an approval that failed (r3 N6). (r1 asked for every third-party plugin and approved whatever the answer; r2 asked for
  every third-party plugin and left it off on a "no".) The approval screen reads Chrome's answer for the plugin when it
  opens (`installOf`, F6), never the view's cache, so a developer copy is shown as one. Automation cannot answer
  Chrome's prompt: the e2e build, and only it, lets a test answer it (`__PLUGIN_TEST_ANSWERS__`, page `localStorage`
  `sk_test_management`); `check-dist` fails a store or developer build that carries the key (r3 N4).
- **Every change is told**: by `runtime.sendMessage` to an official or listed plugin at once, and on the next surface port to
  an unlisted one (right after the answer to its hello).

## 4. The popup and the side panel

- `Main.tsx` loads the platform's chunk only when the profile has plugin approvals or a plugin said hello in this browser
  session, and only in the unlocked list's view. The lock screen, the PIN, the confirm page and every other screen have
  none of it (§7.6).
- **No read of its own on the way**: an open of the popup reads at most 6 times from `chrome.storage.local`
  (`test/e2e/perf.spec.ts`, a hard gate), and asking for `sk_plugins` made it 7. So the popup reads a page hint,
  `sk_plugins_any` in the page's `localStorage` (like the install check's `sk_install`), and, without it, the session's
  hellos. Every verified read of the grant store (`src/ui/plugins/view.ts`) sets the hint when the profile has an
  approval or a record that failed its tag, and clears it otherwise; a locked page leaves it. It only decides whether the
  code loads: what is drawn comes from the verified record. Residuals: with plugins approved, the chunk's own verified read
  comes after the first code (outside the gate's scenario, which has none); with the hint lost (site data cleared), the
  popup shows no plugin until Settings › Plugins is opened once or a listed plugin says hello.
- **The Plugins button**: the popup has no ⋯ menu, so `popup.menu` is a button in the header (a puzzle piece) that appears
  only when some plugin has an entry there, and opens a small menu under "Plugins". At most 2 entries per plugin and 8 in
  all are shown, the rest under "More plugins…".
- **Every entry** is Sixkey's own element: the title as text (NFKC, the plain-text characters removed, cut to 32), a
  builtin icon of the platform's own set or a checked PNG through `<img>`, and "Provided by <plugin>" with its badge; a
  dashed outline, never Sixkey's accent or a filled button. A third-party title, or a third-party plugin's given name,
  that uses a protected term is not drawn. Only a trusted click counts.
- **The quiet line**: "Plugins waiting for your approval: N · Review", "<plugin> changed · Review", or "Sixkey could not
  check its plugin approvals. Review them." Review opens Settings › Plugins. Sixkey never opens a window or a tab for a
  plugin.
- **A click** opens the plugin's interaction window (`sk_plugin_window`, bound to the slot: `popup.menu` and
  `settings.page` allow nothing, `add.sources` W2's add list, 120 s, once) and sends `slot.invoked`: to an official or
  listed plugin by `runtime.sendMessage` (a delivery that fails within 400 ms says "<plugin> did not answer"), to an
  unlisted one on a port after its hello (a changed descriptor there suspends it and sends nothing).

### 4.3 env.get's theme and language

A worker has neither `localStorage` (where the theme and language choices live) nor `matchMedia`. Each Sixkey page that
loads the platform writes the theme and language it resolved to `storage.session` (`sk_plugin_env`), and the worker
answers from it; with none, `light` and the browser's language. A port's `env.get` is answered by the page itself. A
known limit (review F9, kept): a page loads the platform only while unlocked, so the answer can change at the first
unlock of a browser session, and a plugin that polls `env.get` can see when that was; the answer itself is the same in
every lock state.

### 4.4 Known limits kept (review F10, F13)

- A hello that suspends the plugin waits for that write, which takes the vault lock: its answer can be slower while the
  vault is being written (a weak timing signal; the answer itself is the same).
- An overlay entry's age is the wall clock's: a clock moved back can make a suspension look older than the approval,
  until the next hello compares the descriptor again (and the drawing is from the approved descriptor anyway).

## 5. Text

All of the platform's words are a catalog of their own, `catalogs/plugins-<lang>.json` (`scripts/i18n/plugins.py`
`PLUGINS_EN`/`PLUGINS_ZH`, read through `src/ui/plugins/text.ts`), loaded with the platform's lazy chunks by the popup, the
side panel and the settings page, and counted in none of their up-front budgets, as the shares' catalog is. The rail's one
word, "Plugins" / "插件", is the only key in the settings core. New text says "recovery key" / "恢复密钥".

## 6. Budgets

Measured on the live tree with fingerprint unlock (PRF) merged, W1a r3 on top (gzip bytes; check-dist):

| What | Before (live, PRF in) | After | Limit / allowance |
| --- | --- | --- | --- |
| Popup, gate open (store build with the sync interface) | 58,709 | 59,151 (+442) | +700 allowed; 61,440, owner floor 1,500 headroom (2,289 left) |
| Popup, gate closed (today's store build) | 57,450 | 57,897 (+447) | 61,440 |
| Side panel, gate open | 60,948 | 61,379 (+431) | 63,488 |
| Settings, every part together (zh_CN) | 12,106 | 12,123 (+17) | +30 allowed; 12,288 (165 left) |
| Plugins text (zh_CN; en 1,316) | — | 1,612 | its budget 3,072 (measured + 1.5 KB, rounded up to 512 B) |
| A vault's page with every lazy catalog in: shares, device unlock, plugins (zh_CN; en 13,330) | 13,830 | 14,979 (+1,149) | 15,360 (381 left) |

The key-change record's wrapper in every context's runtime (a dynamic import, so its code stays lazy) costs about 220 B
of the popup's; the rest is in the lazy chunks and their catalog. **W2 cannot fit P1/P2's cards and approval words in the
381 B left**: it must split the plugin catalog (the buttons' and provenance's words for the popup and side panel, the
approval and cards' words for the settings page and the cards only), or ask the owner to raise the lazy page's limit;
nothing of W2 can go in the settings core (165 B left).

The lesson of the first measure: lazy code that imported `core/sync/local/records.ts` and `core/crypto/keyring.ts`
regrouped the closed popup's chunks (+969 B); asking the service instead (`grantKeys()`, which unwraps the previous keys
only when asked) brought it to +197.

## 7. Tests

- Unit (`test/unit/plugins-*.test.ts`): `plugins-core` (JCS, the worked `contributionsHash`, plain text, protected terms,
  keys, PNG, the lenient descriptor, negotiation, the allow-list, the catalog, trust, ceilings, slots, states),
  `plugins-grants` (K_g and the tag, what the tag binds, strict records, tighten-only, stale overlay entries, the store's
  verified reads, a failed tag kept, no laundering, rollback, the epoch, the overlay merge, pauses, the re-tag after a key
  change), `plugins-protocol` (drops, sender kinds, the order of checks, the schema, `not-granted`, the rate, hello's
  states and changes, the pin, management's versions, the waiting limit, what P0 learns), `plugins-slots` (what is drawn,
  provenance, protected terms, grouping, PNG, the click's body, the interaction window, the session's records),
  `plugins-dom` (the approval screen's words and its 600 ms, the entries' trusted click, the address),
  `plugins-hint` (the popup's page hint: set, cleared, kept for a failed tag, left while locked), `plugins-rekey` (r2:
  the key-change record over a real runtime: the rotation re-tags it; a record forged under the retired key afterwards
  is refused; a rolled-back one is not re-tagged and the cleanup still finishes; a damaged one never holds the marker
  up; the contract's five answers; a storage error propagates), `plugins-worker` (the
  worker's listener and the surface ports against a fake `chrome`: drops, the 1.8 s answer, the
  overlay writes, a plugin-opened port refused, hello first, the idle close, `grants.changed`), and
  `plugins-source-rules` (one responder, ports, management's calls, lazy loading, no `t()`, no plugin content on the
  screens that ask for secrets, no frames, the address, the records' writers).
- Crash safety: `test/fault/plugin-grants-crash.test.ts`, every write of nine operations interrupted before and after it
  lands (and torn), with the session kept and the browser restarted.
- Hand-made mutants of the platform's code (r2: 95, one edit each, run against their target tests): all killed, 93 by a
  plain assertion and two (C1, R2F1b) by an assertion that an answer resolves where the mutant makes it reject. The tag
  (G1–G3), what it binds (B1–B4), the epoch, rollback and write order (E1–E5), tighten-only (O1–O6), the allow-list
  (A1–A5), the pin (H1–H5), the sender checks (S1–S6), the rate (R1–R3), the order of checks and what P0 learns (C1–C7),
  plain text, protected terms, keys and icons (P1–P8), the lenient descriptor (D1–D4), trust, slots and the click
  (T1–T7), the 600 ms delay (I1–I3), ports (Q1–Q3), the screens that ask for secrets, the address and `management`
  (L1–L4), the popup's hint (V1–V3), and one for each check r2 added (R2F1a–R2T: own-property lookups, one plugin per
  slot, Chrome's name, the log's types, rate and cap, the key-change record's epoch, active-key check and wiring, a read
  under another key, minVersion, OD-2 in both places and the recorded versions, OD-1, F6, the word runs and CJK
  separators, the test-only answer). Source rules kill L1–L4, V3, R2OD1, R2F6 and R2T, and with behaviour tests C6 and
  C7; behaviour tests the rest. Six on the e2e build, each killed by `plugins.spec.ts`: the list drawn while locked, the
  address opening the approval screen, `env.get` telling the lock state, no input delay, a plugin button on the
  add-confirm page (the review's K8), a refused prompt that still approves.
- The review's own mutants (`REVIEW-mutants.py`) on r2: killed K1, K2, K4–K6, K9–K11, K13–K16, K19 and the build-level
  B1–B4; K12 and K18 now by unit tests as well as the browser's; K8 by the browser test only (the confirm page lives in
  Main.tsx); K7 and K17 no longer apply (their code moved: the checks are R2F4a and R2F2, killed); K3 is equivalent in
  Chrome (a sender ID is always an extension ID), as the review says.
- `check-dist`'s own mutants (`m5-check-dist.test.ts`): `externally_connectable` to web pages, to another ID, to every
  extension, missing; an optional permission more; a second listener; the port listener gone; management's other calls; a
  port from the worker; the platform in the popup's static graph; its text preloaded. (Since 2026-10-27 also the store
  shape's: an empty `ids`, a host of `.invalid`, the reserved ID beside anything else, and the same value in other bytes;
  `EXTERNALLY-CONNECTABLE-NOTES.md`.)
- End to end (`test/e2e/plugins.spec.ts`, with Sixkey, the test plugin listed and its unlisted copy): the handshake, the
  approval (and its delay), the entries in three slots, the click's event, off, on and remove, a changed descriptor
  suspending (the overlay, the merge, approving again; the pin; an unlisted plugin between two ports), a failed tag, no
  lock state for P0 and nothing on the lock screen, the browser's refusal of an unlisted plugin, a plugin-opened port
  refused, the untrusted address, the leaf at 320 px.
- Rule tests changed on purpose: the build tests that copy the extension (`m5-build-guard`, `budget-check-dist`,
  `m6-gate`, `quickview-check-dist`) copy `plugins/` too, as they copy `catalogs/` (every build reads the catalog, and a
  missing one fails it); `autofill-pre-source-rules` (the two plugin modules are the only other way in),
  `budget-split` (the `grantKeys` member, the plugins catalog's budget), `short-settings-route` (six groups),
  `m5-check-dist` (the externally_connectable mutant now fails on its value), `enroll-v2` (the plugin ID field is a text
  input of its own, `#plugins-add-id`), the service worker's fakes (`sw-world`, `m5-sw-wiring`, `m5-sw-locks`,
  `m5-permission-handlers`, `quick-sw-alarm`: `onMessageExternal` and `onConnectExternal`, once each), the e2e harness
  (Sixkey found by its name among several extensions), `visual-guard` and `short-settings` e2e (six groups), and the
  test DOM (`onpointerdown`, for the approval screen's delay).

## 8. Deviations from the brief and the spec, and why

- Assertions r2 changed on purpose, each for its finding: `plugins-grants`' re-tag test now expects a read under another
  key to fail and nothing to be rewritten (F4; the re-tag is `plugins-rekey`'s); `plugins-slots`' given-name test now
  expects the entry drawn under the plugin's ID (F2); `plugins-core`'s state test and `plugins-protocol`'s version test
  now expect a P0 plugin's new version to pause nothing, and minVersion to follow the version now (OD-2, F5);
  `plugins-source-rules`' management rule now pins both enabling clicks and that a "no" approves nothing (OD-1);
  `plugins-dom`'s wording assertion follows the new approval line; `m2-source-rules` A4R-4 pins `vkRecords: [...sync.records, pins, grants]` and the grant
  record's lock (with PRF: `pins, prfs, grants`).
- **`account.actions` is not offered** in wave 1a: it needs P1 (`accounts.read`, §7.1, V-4), which is W2. The account
  menu's slot comes with P1; until then a contribution to it is listed in `unavailable`.
- **`add.sources` shows only official and listed plugins** (§7.1), and the store catalog lists none yet, so in a store
  build it is empty until a plugin is reviewed.
- **No harmless-change write**: a version or description change is accepted without asking, but the stored descriptor is
  the approved one until the next approval (the spec's "is stored" became a MAY).
- **A `VkRecord`** for the grant store again (r2, review F4): r1's re-tag at use accepted any retired key at any time.
- **The developer build lists the e2e catalog's IDs**, not `["*"]` (a MAY), so no build answers an unknown ID.
- **A subset of TR39's confusables** (stated in §7.3); the rule also covers third-party names and unlisted publishers.
- **The catalog's "Get" list** is not drawn: the store catalog is empty; the listed test plugin is installed in the e2e
  build. It comes with the first reviewed plugin.

## 9. Questions for the owner

- **Where the Plugins button sits.** The popup had no ⋯ menu; wave 1a puts a puzzle-piece button in the header, shown only
  when a plugin has an entry there (OWNER-CHECKLIST 37 asks). The conservative alternative, inside the View menu, mixes
  plugins with appearance.
- **The approval screen's words** are Appendix B's drafts plus one line about Chrome's `management` prompt: to be approved
  with the store copy (OWNER-DECISIONS/06).

## 10. The review's fixes (r2)

The independent review of r1 (`修改后通过`, 2026-10-23) asked for F1–F8 and decided OD-1 and OD-2 on the user's side;
r2 does them, the suggestions, and keeps three known limits as documented.

- **F1** A plugin's words are read as its own properties only (`Object.hasOwn`: a contribution may be called
  `constructor`, a table may be empty), and every plugin is worked out on its own: one whose record cannot be read is
  left out of its slot alone, listed in Settings › Plugins by its ID with "Sixkey cannot show this plugin's buttons."
  and Remove; the rest of the page and the slot are drawn.
- **F2** Every third-party name Sixkey shows, the descriptor's or Chrome's (`management`: the plugin's own manifest), is
  held to the protected terms; a refused one is shown as the plugin's ID (approval screen, list, provenance line).
- **F3** The request log holds this version's request types (and Sixkey's own `port`, `slot.invoked`), else `other`, on
  write and on read. **F11** At most 30 lines a minute per plugin are written, checked before the write, and each plugin
  keeps its last 20 of the 100.
- **F4** The key-change record (§2.2): only the cleanup uses a retired key.
- **F5** minVersion is held to the version the plugin has now (§2.3). **F6** The approval screen reads Chrome's answer
  when it opens.
- **F7** OWNER-CHECKLIST 38 now expects what this build does (a version-only change of a P0 plugin pauses nothing and is
  said in Settings). **F8** Tests for the delay's visibility and key-press branches, and two browser tests from the review
  (the header at 376 px in both languages; the add-confirm page draws nothing of a plugin).
- **OD-1** `management` only in an enabling click; a "no" leaves the plugin off (§3). **OD-2** A P0 plugin's new version
  pauses nothing (§2.3).
- **F12** Protected terms however they are spaced or punctuated ("Six Key", "P I N", "P1N 码"). **F14** PRIVACY says
  Sixkey cannot be detected through extension messaging (not "as if not installed") and what `management` allows;
  local-vault's worker line and re-tag line, the SDK header, and `pxLead` ("Plugins by others…") are fixed. **F15** One
  plain-text set, one PNG pattern, one capability list; a test holds the two copies of the puzzle path equal.
- **Kept, documented** F9 (§4.3), F10 and F13 (§4.4). OD-3 (the header button) and OD-4 (the page hint) stay as built;
  OD-5 (the approval words) goes with the store copy.

## 11. The second review's fixes (r3, step 1 on the pre-PRF tree)

- **N1** The text compared is the text drawn: `fold()` takes out the characters plain text refuses first (the Hangul
  fillers U+3164, U+115F, U+1160, U+FFA0 are letters that show nothing), and `shownName` checks and returns
  `displayText(name, 40)`.
- **N2** A surface port's finding (a changed descriptor) goes to the overlay, as the worker's does: never a tagged write
  with the key the page loaded with, which a key change since would have retired, moving every approval to review.
  `openPort` and `invoke` take no key any more. A residual, as the SDK says: a tagged write from Settings (an approval, a
  switch) that races a key change between `grantKeys()` and the write fails its tag the same way; closing it would mean
  checking the active key inside `write()`'s lock, which needs `records.ts` (W2, measured first).
- **N3** OWNER-CHECKLIST 37: a plugin added by its ID is approved without Chrome's prompt; the prompt is a step of its
  own, in the developer build, where the test plugin is listed.
- **N4** The test's answer to Chrome's prompt is in the e2e build only; `check-dist` fails a store or developer build
  with `sk_test_management`.
- **N6** Chrome's "yes" followed by a failed approval gives `management` back unless another plugin still needs it.
- **N7** CJK: a visible separator (· / 、 ：, a bracket, a symbol) ends a term; spaces, dashes and underscores do not.
  "了解 · 锁定" passes, "解 锁" and "P1N 码" are refused. A known limit: "解·锁", its separator in plain sight, passes,
  and "了解锁定原理" (no separator at all) is refused, as in r1.
- **N8** `recordVersions` and `reencrypt` are in the crash matrix.
- **N9** A sentence of §7 that named an r1 change as r2's is gone.
- **OD-1 narrowed** (above, §3).
- **N5, a W2 must-fix (no code now):** with `management`, a plugin holding more than P0 whose descriptor `version` is
  written differently from its manifest's (`1.0.0` and `1.0`) is suspended at every hello, before `recordVersions` and
  after it. Before W2 grants anything beyond P0: make "the descriptor's version is the manifest's" a MUST checked at
  hello when Sixkey holds `management`, or compare versions normalised (trailing `.0` parts dropped).

### 11.1 Step 2: on the live tree with PRF merged

- Rebased onto the live tree with fingerprint unlock (PRF r3) merged, regenerated against it. Shared files: the vault's
  key-change records are `[...sync.records, pins, prfs, grants]` (`runtime-base.ts`, and `m2-source-rules` pins the
  same line and the grant record's lock); `check-dist`'s plugin constants follow PRF's `DEVICE_CATALOG_GZ`, and the
  combined check of a vault's page holds the shares', the device unlock's and the plugins' text; `messages.py`
  `PLUGINS_VIEW = DEVICE_VIEW + ["plugins"]`; `budget-split`, `autofill-pre-source-rules` next to PRF's lines;
  ARCHITECTURE's three rows and local-vault's two padded to PRF's widths, nothing re-flowed; OWNER-CHECKLIST 37–38 after
  PRF's 36. `OWNER-DECISIONS/` is not touched.
- Tests on that tree: full unit 258 files, 3,883 passed (4 expected failures, 1 skipped); full e2e 383 passed (1
  skipped); e2e:sync 12. Mutants: these 112 all killed (the 111 of the batch and R3K18) (109 by a plain assertion; C1 and R2F1b by an assertion that an
  answer resolves where the mutant makes it reject); e2e EM1–EM6 killed. The reviews' own: of r1's, K1, K2, K4–K6,
  K9–K16, K19, B1–B4 killed, K8 by the browser test only, K3 equivalent, K7, K17 and K18 without an anchor (their code
  moved: R2F4a, R2F2 and R3K18 are the same mutations on it, killed); of r2's, M1–M3, M5–M12, M13b, M14, M16, RB2 killed,
  M13 equivalent (as the review says), M4, M15, M17 and RB1 without an anchor (moved by PRF's records line and by N1, N7
  and N4; R2F4c, R3N1a/b, R3N7a and R3N4a are the same mutations, killed).

