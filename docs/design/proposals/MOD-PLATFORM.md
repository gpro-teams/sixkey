# Plugin platform, developer features, and autofill as a plugin: design study (MOD-PLATFORM), v3.1

> **Study: not approved, not implemented.** Nothing in `extension/`, `api/` or `contract/` changes because of this
> document, and it edits no other document. Where another document would have to change if a recommendation is taken,
> §7 and §9 list what, and none of it is edited here.
>
> **Since then (2026-10-23):** the owner took the recommendations (OWNER-DECISIONS/16: Q-A (a), Q-B "balanced", no codes
> for other people's plugins in version 1). Wave 1a, the platform's core and P0, is implemented
> (`docs/design/notes/PLUGINS-W1A-NOTES.md`); what it settled is in the SDK spec's revision 1.0-draft.7. One change to
> Q-B since, decided as engineering after the wave's review (it narrows a cost the owner accepted): optional `management`
> is asked only when a listed (reviewed) third-party plugin is enabled, the one case where a same-key developer copy
> could take rights (M0-8); a plugin added by its ID never asks. Wave 1b, §7.2 Option I (autofill as the built-in official
> plugin, `scripting` optional, Off and On) with Chrome 140 as the minimum (OWNER-DECISIONS/14 OQ1 (a)), is implemented
> (2026-10-24, `docs/design/notes/PLUGINS-W1B-NOTES.md`); one finding changed item 4's order: Chrome keeps running a
> registered content script after `scripting` is given back, so the worker unregisters first. S-5 (§12.2, a developer
> switch in the store version) was decided on 2026-10-30, as recommended (OWNER-DECISIONS/19 question 1 (a)): none; a
> developer tries P1 and P2 in the developer build, with the plugin on that build's own list (SDK §11.5, implemented:
> `docs/design/notes/DEVREAD-NOTES.md`). This study is kept as written: the SDK spec is the normative text.
>
> **Version 3.1 (2026-10-23)** folds in the reviewer's verification of v3 (`MOD-PLATFORM-V2-REVIEW.md` §6, findings
> W-1 to W-11 and schema gap checks GAP-1 to GAP-9, no blocker and no new High) and the follow-up probes. **Appendix W**
> says what was done with each. The SDK spec moves to 1.0-draft.4. The changes:
>
> - **Approvals:** each plugin's state is stored and tagged; writes while locked can only tighten; a failed tag no longer
>   wipes every approval; no entry is drawn before the tag verifies (§5.6).
> - **Forward compatibility:** what this Sixkey cannot read is dropped item by item, not fatal (SDK §4.3).
> - **Exact rules:** which descriptor changes are harmless (an allowlist), the exact `contributionsHash` with a worked
>   example, the shortcut grammar for `keys`, and `waiting` as an error for `codes.forPage` only (SDK §4.2, §5.1, §10.3).
> - **The interaction window is bound to the slot that was clicked** (§5.8).
> - **The probes closed:** `frame-src` and `sandbox` (§1.6, M0-12), `windows.create` (M0-13), the race (M0-10), what
>   keeps a worker alive (M0-9 (d), (e)), and the Site access line (B2).
> - **Q-A and Q-B** state every option's gains, and the trust cost of `management` (§12).
>
> **Version 3 (2026-10-23)** folds in the independent review of v2 (`MOD-PLATFORM-V2-REVIEW.md`, findings V-1 to V-25, no
> blocker) and the probe results (`probes/RESULTS.md`, Chromium 156.0.8078.4; source **PRB** below). **Appendix V** says
> what was done with every V-n, and **Appendix R** keeps the record for the v1 review's R-1 to R-40. The main changes from
> v2:
>
> - **The owner decides two things instead of thirteen** (V-21, §12):
>   - **Q-A**: the platform, and where autofill lives;
>   - **Q-B**: how open Sixkey is to other people's plugins, as three presets.
>     Everything else is a default or belongs to an existing OWNER-DECISIONS file.
> - **The costs of building a platform are stated** (V-20).
> - **Probes answered most open questions** (§1.6):
>   - ports opened by Sixkey work, and Sixkey stays undetectable through messaging;
>   - an impostor with the same `key` takes over storage and grants;
>   - an embedded plugin page can steal the focus and navigate Sixkey's tab away;
>   - any extension can open Sixkey's settings page with a fragment of its choosing;
>   - Chrome's details page never lists `scripting`.
> - **Embedded plugin pages are out of version 1** (V-22).
> - **`sites.propose` is official-only** (V-2).
> - **A release has one meaning:** one arm, one tab, one origin, one account (V-1).
> - **Plugins cannot open Sixkey's windows at will** (V-3).
> - **Account slots need P1** (V-4).
> - **A fixed order of checks leaks nothing to P0, nor the lock state to P1** (V-5).
> - **The descriptor's life is specified** (V-6).

Date: 2026-10-23. Author: design study (Opus 5.5) at the owner's request. Independent reviews: `MOD-PLATFORM-REVIEW.md` (of
v1) and `MOD-PLATFORM-V2-REVIEW.md` (of v2, and in its §6 of v3), with its probes.

**Markers**, as in the other proposals, with the source named (the source IDs are in §13):

- **[verified: X]**: I read the primary source X. That means this repository's code, an official Chrome, Chrome Web
  Store, Android or VS Code page, or Chromium's source. Chromium was read on the GitHub mirror of `main` on 2026-10-23,
  which is not necessarily the stable binary, through a fetch tool that returns short verbatim excerpts.
- **[probed: PRB]**: measured by the reviewer's probes in the bundled Chromium 156.0.8078.4, with command-line installs
  (`probes/RESULTS.md` and its raw logs).
- **[transcribed: X]**: taken from this repository's notes or from a review (REV for v1, REV2 for v2), and not re-read by
  me.
- **[inferred]**: my own reasoning.
- **[estimate]**: a number nobody measured.
- **[unverified]**: a claim nobody could check yet. All of them are collected in §11.

**Names used below:**

| Name         | What it labels                                  |
| ------------ | ----------------------------------------------- |
| P0–P3        | the capability tiers                            |
| W0–W3        | the platform's waves                            |
| patch 1 to 4 | autofill Stage 2's patches (OWNER-DECISIONS/14) |
| M0–M7        | the patches of option D                         |
| O1–O4        | the origin-trust rules                          |
| R-n          | the findings of the review of v1                |
| V-n          | the findings of the review of v2                |
| W-n, GAP-n   | the findings and schema checks of the v3 review |
| Q-A, Q-B     | the owner's two decisions                       |

---

## 0. Summary and recommendation (read this first)

### 0.1 What the owner asked (translated)

1. **2026-10-22:** "Build plugin (mod) sideloading, open up developer features, and turn our autofill into a plugin
   feature instead of built-in." ("做插件（mod）旁加载，开放开发者功能，把我们的自动填写变成插件功能而不是内置".)
2. **2026-10-23, clarifying:**
   - "Our extension (plugin) permissions must be broad enough. I want people to be able to create interesting tools, so
     the SDK spec must be written to a proper standard."
   - "For example, a random password generator plugin, or a full-page screenshot plugin, must be possible."
   - "Leave places (slots) for plugins in the UI."
   - "Limit plugin permissions: which are read-only, which read-write, which are sensitive permissions, etc. (like the VS
     Code marketplace)."
   - "And distinguish official plugins from third-party plugins."

The owner's standing rule applies throughout: "push the features to the limit, but don't make them complicated"
("把功能做到极限但是不要复杂").

### 0.2 The answer in brief

1. **A plugin is a separate Chrome extension.**
   - It cannot be code inside Sixkey: MV3's CSP floor forbids it.
   - Sandboxed pages cannot reach a page, and `chrome.userScripts` would turn the vault into a user-script host (§2).
   - Plugins talk to Sixkey through Chrome's extension messaging. "Sideloading" is Chrome's **Load unpacked**, plus, for
     Sixkey itself, data packs (§2.3).
2. **"Broad enough" comes from two permission systems** (SDK spec §3.2).
   - **Chrome's permissions belong to the plugin.** Chrome shows them at install: pages, screenshots, downloads, the
     clipboard, the network.
   - **Sixkey's capabilities are API scopes**, like OAuth scopes. They govern Sixkey's data and UI only:
     - **P0 Contribute:** buttons, nothing from the vault;
     - **P1 Read metadata:** the account list, sensitive, because labels are often email addresses;
     - **P2 Propose changes:** add, rename, regroup, trash, always through a list Sixkey draws;
     - **P3 Codes:** per request;
     - **Never:** seeds, `otpauth`, exports, backups, recovery material, the master password, the PIN, settings writes.
   - **VS Code itself has no capability tiers** (S20). It relies on publishers, a trust prompt and a block list, which
     Sixkey borrows.
   - **The owner's two examples need nothing from the vault.** They are a P0 button plus their own Chrome permissions.
3. **Five facts decide the design.**
   - **F1.** `activeTab` is per extension [verified: C6]. A click in Sixkey grants it to Sixkey only, and
     `action.openPopup()` grants it to nobody [verified: C8].
   - **F2.** The core's install warnings are already zero [verified: S10, S11].
   - **F3.** The core cannot see a gesture made in another extension [verified: C4].
   - **F4.** An ID does not prove the publisher. A copy with the same `key` **takes over the original's storage and
     runtime-granted permissions** [verified: C9, C10; probed: PRB M0-8]. Only the optional `management` permission shows
     `installType: "development"` [verified: S17].
   - **F5.** A click in Sixkey's own UI is a gesture Sixkey sees, so it can be the consent for that one action (§3.8).
4. **Origin trust: O1–O4** (§3). A code for a page goes only:
   - to a plugin **content script**, for the browser-recorded origin (O1);
   - after an **arm** from the plugin's worker (O2);
   - for the **tab in front** (O3);
   - while the user is **active** (O4).
5. **Recommendation, as the owner's two decisions (§12):**
   - **Q-A (a):** build the platform in waves.
     - Autofill becomes a **built-in official plugin**: same package, same capability gate, a switch in Settings ›
       Plugins, and the page permission held only after first use.
     - The Fill button keeps working on every site.
     - W1 including autofill: about 6–10 agent-days and 5–7 review rounds [estimate].
     - The two showcase tools start as samples, and their publication is decided after the owner has used them.
   - **Q-B "balanced":**
     - buttons (P0) for any plugin;
     - account names and proposed changes (P1–P2) only for plugins the project reviewed and lists in a release;
     - **no codes for third parties in version 1**;
     - unlisted plugins added by the user;
     - optional `management` at the first third-party plugin;
     - the block list in each release;
     - no brokering.

### 0.3 Recommendation in one table

| Area                        | Recommendation                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mechanism**               | Separate extensions. `externally_connectable.ids` lists the official and listed IDs of each release, with no `matches`. Unlisted plugins are reached through a port that a **Sixkey surface** opens, and which lives with that surface (PRB M0-9). |
| **Tiers**                   | P0 (non-account slots, theme, language), P1 (account list, account slots), P2 (add, update, trash via Sixkey's change list; `sites.propose` official-only), P3 (codes per request; page fill under O1–O4), Never (SDK spec §6).                    |
| **Surfaces**                | Plugins cannot make Sixkey's windows appear. Exceptions: once within 120 s of the user's click on that plugin's entry, and the official locked flow. Cards ignore input for 600 ms (SDK spec §6.4).                                                |
| **What plugins learn**      | A fixed order of checks. P0 never learns the lock state; P1 learns only that Sixkey is open; non-official P3 learns no site match before consent (SDK spec §10.6).                                                                                 |
| **Slots**                   | Declarative entries drawn by Sixkey. Default for W1: popup menu, account menu, Add menu, Settings page. **No embedded plugin pages in version 1** (PRB M0-12).                                                                                     |
| **Approvals**               | One authenticated grant store: a MAC under a vault-derived key, binding every plugin ID and an epoch. The trust level is computed at run time and never stored (SDK spec §6.6).                                                                    |
| **Official vs third-party** | Official: compiled in. Listed: compiled in after a review, with contributions pinned by hash. Unlisted: added by ID or by _Connect to Sixkey_, P0 (P1 in developer mode, if Q-B includes it). Optional `management` detects developer copies.      |
| **Autofill**                | A built-in official plugin (Q-A (a)). C and D are designed and kept as options.                                                                                                                                                                    |
| **Permissions of the core** | Install warnings stay 0. Added: `externally_connectable`; optional `management`; `contextMenus` only for the toolbar-icon slot. `scripting` becomes optional, which shows nowhere in Chrome's UI (PRB B2).                                         |
| **OWNER-DECISIONS**         | 14 OQ2 keeps the in-page click question; 07 gets the publisher account; 03 the plugin-name rule; 06 and 14 OQ3 the data-transfer wording (W2); 01 already settles the SDK's licences.                                                              |

### 0.4 Where autofill lives: what the user sees

| What the user meets                      | **I. Built-in official plugin** (recommended)                                          | **C. Official companion for suggestions**                                                                                                        | **D. Full split**                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Extensions to install                    | one                                                                                    | one; a second for per-site suggestions                                                                                                           | two                                                                                     |
| **Fill code** on the card, on any site   | yes, as today                                                                          | yes, as today                                                                                                                                    | only on sites the plugin already has; on a new site its own popup asks Chrome once (F1) |
| Alt+Shift+F                              | Sixkey's                                                                               | Sixkey's                                                                                                                                         | the plugin's                                                                            |
| Per-site suggestions (the badge)         | in Sixkey                                                                              | in the companion; its badge leads to Sixkey's icon or shortcut                                                                                   | in the plugin                                                                           |
| In-page one-click fill (patch 4, paused) | possible, under OQ2                                                                    | **not possible**: Sixkey's popup, opened by `openPopup()`, has neither `activeTab` nor a grant (C8). The suggestion says _Click the Sixkey icon_ | possible on granted sites, under OQ2                                                    |
| Settings › Plugins                       | _Autofill · Official · Built in · On/Off_; Off removes `scripting` and the site grants | _Sixkey Autofill suggestions · Official_                                                                                                         | _Sixkey Autofill · Official_                                                            |
| Codes leave Sixkey's extension           | no                                                                                     | no                                                                                                                                               | yes, under O1–O4                                                                        |
| K1 (review of `https://*/*`) on the core | yes                                                                                    | no                                                                                                                                               | no                                                                                      |
| "No content scripts" in PRIVACY          | true until autofill is first used                                                      | false for the core                                                                                                                               | true for the core                                                                       |
| Effort [estimate, REV §4]                | 1–2 agent-days, 2–3 rounds                                                             | 2–4 agent-days, 2–3 rounds; a second store item                                                                                                  | 4–7 agent-days, 6–9 rounds; ≥ 1 week of the owner's use; store review                   |

### 0.5 The owner's decisions

Two, in §12: **Q-A** and **Q-B**, each with a default. OQ1 to OQ3 of OWNER-DECISIONS/14 stay open as they are.

---

## 1. Facts that decide the design

### 1.1 Chrome: where code may run, and who gets page access [verified unless marked]

| Fact                                                                                                                                                                                                                                                                                                                                                             | Source                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| The MV3 `extension_pages` CSP has the minimum `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` and "cannot be relaxed beyond this minimum value"; `'unsafe-eval'` fails at install.                                                                                                                                                                    | S4                                |
| Extension service workers do not support dynamic `import()`.                                                                                                                                                                                                                                                                                                     | [transcribed: TOTP-AUTOFILL §1.1] |
| Sandboxed pages are "served in a sandboxed unique origin", "won't have access to extension APIs", and talk through `postMessage()`. Their default CSP includes `'unsafe-eval'`.                                                                                                                                                                                  | S5, S4                            |
| `chrome.userScripts` needs `userScripts`, host permissions, and the user's Developer mode (120–137) or "Allow User Scripts" toggle (138+). Scripts run in web pages and message the extension through `onUserScriptMessage`.                                                                                                                                     | S6, S10                           |
| Load unpacked needs Developer mode. An unpacked copy never updates by itself [inferred].                                                                                                                                                                                                                                                                         | S14                               |
| An ID is the SHA-256 of the manifest's public `key`, or of the folder path without one, cut to 128 bits in the letters a–p.                                                                                                                                                                                                                                      | C7, S9                            |
| An unpacked load outranks a store install ("A developer-loaded extension should override any installed type that a user can disable"), and a second copy with the same ID is installed as an **update** (`RemoveExtension(id, UPDATE)`, `AddNewExtension`).                                                                                                      | C9, C10                           |
| `activeTab` is granted "when the user invokes the extension" (action, context menu, command, omnibox), per extension (`GrantIfRequested(const Extension*)`), for the top-level origin, until a cross-origin navigation.                                                                                                                                          | S13, C6                           |
| **`action.openPopup()` grants no `activeTab`**: `TriggerPopupForAPI` sets `kByUser = false` without `RunAction`; "it should never be considered a user action".                                                                                                                                                                                                  | C8                                |
| `tabs.captureVisibleTab` needs `<all_urls>` or `activeTab`, at most 2 calls a second. A tab's `url` and `title` are given only with `tabs` or host access.                                                                                                                                                                                                       | S18                               |
| `scripting` and `management` can be optional. `permissions.request` shows no dialog when the new permissions carry no warning, and needs a user gesture and an active window.                                                                                                                                                                                    | S12, C11                          |
| No install warning: `activeTab`, `alarms`, `contextMenus`, `idle`, `offscreen`, `scripting`, `sidePanel`, `storage`, `unlimitedStorage`. Warnings: `management` "Manage your apps, extensions, and themes"; `tabs` "Read your browsing history"; `downloads` "Manage your downloads"; `pageCapture`, `debugger` "Read and change all your data on all websites". | S10                               |
| `web_accessible_resources` lists objects with `resources` and `matches` or `extension_ids`. By default nothing is web accessible.                                                                                                                                                                                                                                | S16                               |
| `management` needs its permission except `getSelf`, `uninstallSelf`, `getPermissionWarningsByManifest`. `installType` is `admin`, `development`, `normal`, `sideload` or `other`.                                                                                                                                                                                | S17                               |
| `idle.queryState(n)` returns `"active"`, `"idle"` or `"locked"`; no minimum is stated.                                                                                                                                                                                                                                                                           | S21                               |
| A second extension suggesting the same shortcut does not get it; `commands.getAll` returns the caller's own commands.                                                                                                                                                                                                                                            | [transcribed: REV rows 22–23]     |

### 1.2 Chrome: one extension talking to another [verified unless marked]

| Fact                                                                                                                                                                                                                                                                                                                                                                           | Source                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `onMessageExternal` fires for messages from other extensions and "Cannot be used in a content script". Ports: `runtime.connect(id)` and `onConnectExternal`.                                                                                                                                                                                                                   | S1, S3                                                                                                           |
| Without `externally_connectable`, "all extensions can connect, but no web pages". With `ids`, only those can. The key governs connections **into** the extension that declares it.                                                                                                                                                                                             | S2; [probed: PRB M0-9 (b)]                                                                                       |
| A refused connection gets the same error as a missing receiver: "Could not establish connection. Receiving end does not exist.", at the same speed, for callback, promise and `connect`, and so does a listener-less target. Only a listener that never answers can be told apart. A **disabled** target gets the same error, because the lookup is in `enabled_extensions()`. | C1; [probed: PRB M0-9 (b)] for refused, missing and listener-less; [transcribed: REV row 6, source] for disabled |
| The sender object (`DispatchOnConnectToListeners`) has `id`, `url`, `origin`, `frameId`, `documentId`, `documentLifecycle`, `tab`, `tlsChannelId`. **No gesture field.** The `has_user_gesture` bit is metadata asserted by the sender.                                                                                                                                        | C4, C5                                                                                                           |
| `origin` is the browser's `GetLastCommittedOrigin()` of a frame the renderer names within its own process; it is absent for a worker. `url` is checked only against the process (site) lock, so only `origin` and `tab.url` may decide anything.                                                                                                                               | C1, C2; [inferred: site isolation]                                                                               |
| A claimed extension context must be in that extension's `ProcessMap`. A claimed content script needs a process that ran one (`ScriptInjectionTracker`). Failures terminate the renderer.                                                                                                                                                                                       | C2                                                                                                               |
| The tab object is not scrubbed for an extension receiver ("We need the extension to see the sender…"). An extension page sending to another extension shows its full `tab`, including `url` and `title`, even without `tabs`.                                                                                                                                                  | C3; [probed: PRB M0-9 (a)]                                                                                       |
| Content scripts "are less trustworthy than the extension service worker".                                                                                                                                                                                                                                                                                                      | S3                                                                                                               |
| Branded Chrome 137+ ignores `--load-extension`.                                                                                                                                                                                                                                                                                                                                | [transcribed: `extension/test/e2e/harness.ts`]                                                                   |

### 1.3 Chrome Web Store [verified]

| Fact                                                                                                                                                                                                                                                                                                                                    | Source |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Full functionality must be discernible from the package. Violations include remote `<script>`, `eval` of fetched strings, and "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data". The exemptions are the Debugger and User Scripts APIs, and isolated contexts. | S7     |
| Single purpose; "Do not post an extension with a single purpose of installing or launching another…"; no "Bundling other extensions… within the same installation flow"; the narrowest permissions.                                                                                                                                     | S8     |
| Limited Use: "Only transfer user data to third parties… If necessary to providing or improving your single purpose".                                                                                                                                                                                                                    | S22    |
| Broad host permissions such as `https://*/*` lengthen review; updates are reviewed the same way.                                                                                                                                                                                                                                        | S15    |

### 1.4 Other platforms' permission models [verified]

| Platform | What it does                                                                                                                                                                                                                                    | Source |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Android  | `normal` and `signature` permissions are granted at install; `signature` only "when the app is signed by the same certificate". `dangerous` permissions must be requested at run time.                                                          | S19    |
| VS Code  | **No capability tiers**: the extension host "has the same permissions as VS Code itself". Protection comes from the marketplace: scanning, verified publishers, a publisher-trust prompt since 1.97, and a block list with automatic uninstall. | S20    |
| OAuth    | Scopes name what a client may do through one API, not elsewhere [inferred]. This is the closest model for Sixkey's tiers.                                                                                                                       | —      |

### 1.5 This repository [verified: the files named]

- **The manifest** (`extension/manifest.base.json`, held by `scripts/check-dist.mjs`):
  - permissions `storage, unlimitedStorage, activeTab, alarms, idle, offscreen, sidePanel, scripting`;
  - optional `clipboardRead, clipboardWrite`;
  - optional hosts `https://api.sixkey.app/*` and `https://*/*`;
  - commands `_execute_action`, `lock`, `fill`;
  - minimum Chrome 120.
- **External messaging is forbidden today, three times over:** `externally_connectable` is not in `MANIFEST_KEYS`;
  `check-dist` rejects `onMessageExternal` and `onConnectExternal` (pinned by `m5-check-dist.test.ts`); and
  `autofill-pre-source-rules.test.ts` forbids them in the source.
- **`activeTab` has three uses:** the "This site" ranking (`popup/main/Main.tsx`, `sidepanel/guard.ts`), the QR scan
  (`popup/main/scan.ts`), and autofill (`platform/autofill.ts`, `sw.ts`).
- **What option B must handle** (R-8):
  - `autofill-register.ts` takes `chrome.scripting` as a default argument;
  - `fill-command.ts` reaches `executeScript`;
  - `sw.ts` reconciles only on events that name a host.
- **The trust rule for content scripts today.** `contentSender` (`sender-policy.ts`) needs https at the default port and
  ignores every field but `type`. "No code-request message exists" (TOTP-AUTOFILL §9).
- **Stage 1's `schemeOf`:** https at any port; http on an IP address; other http only after M5.
- **Account limits:** issuer and label ≤ 256, group ≤ 64; digits 6 or 8; period 1–86,400 s; ≤ 16 domains;
  ≤ 5,000 accounts.
- **Store and budget.**
  - The store ID is empty (`store-id.mjs`).
  - The popup has about 4.3 KB of its 61,440 B gzip budget left with the sync gate open [transcribed: REV §4].
- **OWNER-DECISIONS:**
  - **01:** contract code is Apache-2.0, contract data CC0-1.0.
  - **07:** the publisher account is deferred until after 06's trial, and there is no second person.
  - **`TRADEMARKS.md`:** "works with Sixkey" is allowed; forks must not carry "Sixkey".
- **The autofill code:** 2,673 source lines in 15 modules; 22 unit files and 5 e2e specs (9,047 lines).

### 1.6 What the probes measured [probed: PRB, Chromium 156.0.8078.4, command-line installs]

| Probe                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                               | What it decides here                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0-9** a port that S opens to P           | (a) **It works both ways** while S declares `ids: []`. P sees `port.sender = {id, url}` with no `origin`. (b) P cannot reach S. Refused, missing and listener-less look the same. (c) **S's worker stopped 30.0 s after the last message although the port was open**: P got `onDisconnect`, and a later `postMessage` threw. S was not woken. Messages every 20 s kept S alive. Playwright's attachment keeps workers awake, so sleep needs raw CDP. (d) **A listener that `return true`s and never answers kept its worker alive for the whole 335 s run**, the sender still pending; the stopped worker had been woken by the message. (e) **An idle port keeps neither end alive**: whoever opened it, with or without messages, the workers stopped 30.1 s later and the other end got `onDisconnect`. (f) **A pending `sendMessage` keeps the sender's worker alive too** (95 s run) | Unlisted plugins through ports work, and Sixkey stays undetectable through messaging. **The port is opened by a Sixkey surface and lives with it** (SDK spec §3.3). Unlisted plugins get no deferred requests, and their events wait for the next port. Sleep tests need raw CDP. **Sixkey never leaves a plugin's request pending beyond its answer times, and never awaits a reply to an event** (SDK spec §3.3 item 6) |
| **M0-10** two `onMessageExternal` listeners | Every listening context fires. **The first `sendResponse` wins**, and the rest are dropped silently. A `return true` with nobody answering leaves the sender waiting. **The winner is not deterministic:** with both answering at once, the first run went to the worker, and 20 repeats on a fresh profile all went to the page | "Lock every time" mode needs a **single responder**: the worker stays silent while an unlocked surface answers (SDK spec §3.3 item 6). Race tests                                                                                                                                |
| **M0-12** an iframe slot                    | **Positive control:** on one page with Sixkey's exact CSP, a `data:` frame was blocked, while the plugin's `chrome-extension://` frame loaded and ran, also under `frame-src 'none'`. **The page's CSP does not gate extension frames**; only the plugin's `extension_ids` does. **The frame is a full plugin page.** Without user activation it **took the focus from a PIN input**, and typed text went into it. Without `sandbox` it **navigated Sixkey's tab** to its own page. **`sandbox="allow-scripts"`, with or without `allow-same-origin`, blocked that navigation, but the frame kept its APIs (even with a `null` origin) and still took the focus** | **Embedded plugin pages are out of version 1** (SDK spec §7.5). A sandbox is no privilege boundary here, and only unmounting a frame stops focus theft |
| **M0-13** P opens S's settings page         | **Any extension, without `tabs`**, can open Sixkey's settings page with `chrome.tabs.create` **or `chrome.windows.create`** and any fragment; Sixkey's script runs. The page sees no referrer, no opener and `openerTabId: undefined`, so **Sixkey cannot learn who opened it**. `tabs.update` of an existing tab, `window.open`, links and web pages are blocked (`ERR_BLOCKED_BY_CLIENT`) | _Connect to Sixkey_ works. **Fragments are untrusted**: they navigate and pre-fill, never act. Whether the opener can tell that the page loaded is open                                                                                                                          |
| **M0-14** a plugin's popup while one is open | Without a gesture, `action.openPopup()` works only while no extension's popup is open; otherwise "Failed to open popup.", even when the plugin answers a message from Sixkey's popup. **Any foreground tab closes Sixkey's popup:** an extension's `tabs.create({active: true})`, with no permission and no gesture, closes it, and that extension's `openPopup()` then succeeds about 370 ms later (7c). With `active: false` Sixkey's popup stays open | Under D, the plugin asks for a new site in a window (`windows.create`) or tells the user to click its icon. Sixkey's own cards and the official lock screen fall back to the badge while another popup is open (SDK spec §6.4). The swap is a residual threat of every extension, not only plugins (§10) |
| **M0-8** the same `key` in another folder   | A copy at a higher **or** lower version **took over `storage.local`, the runtime-granted optional permission and the site access settings** (the withheld `https://*/*`, a per-site `example.com` grant): at once under CDP Load unpacked (location 4), and across a restart under command-line installs. `chrome://extensions` showed one item, "Unpacked extension". With two folders on the command line, the last one listed ran. The Load unpacked button and store installs were not simulated | F4 is confirmed. The optional `management` check matters more (Q-B)                                                                                                                                                                                                              |
| **B2** `scripting` on the details page      | **Never listed**, whether required, optional before, or optional after the grant. `tabs` is listed. Sixkey's own permission set shows an empty Permissions heading and "can read and change your data on sites" under Site access. **That line comes from `activeTab`:** `activeTab` alone gives it, while `scripting` alone and `storage` alone give "requires no special permissions" | Option B's gain is for auditors only (R-7 confirmed): B changes nothing visible in Chrome |

---

## 2. Mechanism: what a plugin can be

### 2.1 The options

| #   | Mechanism                                                                                     | Verdict, and why                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Plugin JavaScript loaded into Sixkey (`eval`, `blob:`, dynamic `import()`)                    | **Impossible**: the CSP floor (S4), no dynamic import in the worker, the store's rules (S7)                                                    |
| M2  | A plugin language Sixkey interprets                                                           | **Rejected**: the store forbids interpreters of fetched commands (S7), and every plugin would run with the vault's privileges                  |
| M3  | A sandboxed page inside Sixkey                                                                | **Rejected**: no extension APIs, so it cannot reach a page. Sixkey would have to expose an API over `postMessage`, which is M2 by another name |
| M4  | `chrome.userScripts` in Sixkey                                                                | **Rejected**: it puts host permissions and an "Allow User Scripts" toggle into the vault, and runs pasted code with messaging into it          |
| M5  | **A companion extension**, talking by extension messaging                                     | **The mechanism.** The browser isolates it and labels its messages (§1.2), and it brings its own Chrome permissions                            |
| M6  | **A data pack**, a JSON file in a closed schema (for example TOTP-AUTOFILL §6.2's rule packs) | **The only add-on inside Sixkey.** It is data, needs no permission, and can call nothing (§2.3)                                                |
| —   | An embedded plugin page (an iframe inside a Sixkey page)                                      | **Out of version 1.** The probe showed full plugin APIs, focus theft and top navigation (§1.6, M0-12)                                          |

### 2.2 What "sideloading" means

- **Developers** use Chrome's Load unpacked (S14).
- **Users** add an unlisted plugin in Settings › Plugins, by pasting its ID or through _Connect to Sixkey_. A plugin may
  open Sixkey's settings page with its ID pre-filled, which any extension can do (PRB M0-13). The user always approves in
  Sixkey, and the fragment never acts on its own (SDK spec §9.2).
- **Unlisted plugins get P0**, plus P1 only if Q-B includes a developer switch.
- **Copies with a store item's `key`** take over the store copy's storage and grants (F4).

### 2.3 Data packs

Rule packs wait for Stage 3's schema and validator (TOTP-AUTOFILL §6.2–§6.3). Icon or theme packs are possible later
[inferred]. They are listed so that "sideloading into Sixkey" has an honest answer. They are not scheduled.

---

## 3. The crux: origin trust

### 3.1 What the core trusts today

- **Data only from its own content script.** Stage 2's patch 3 takes from its own content script only `sk-af-cand`, which
  holds no secret, and reads the page's identity from the browser's sender fields.
- **The code is pushed, never pulled.** It is the argument of one `executeScript` pinned to one document.
- **No request channel exists.**

### 3.2 What a message from another extension carries

| Sender                                   | `origin`                                                             | `tab`                   | Who sets it                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| X's **content script**                   | the committed origin of a frame in X's process                       | the tab, unscrubbed     | the browser; `url` is checked against the site lock only; the ID needs a process that ran X's script (C1–C4) |
| X's **worker**                           | absent                                                               | absent                  | the browser; the process must be X's (C2)                                                                    |
| X's pages                                | `chrome-extension://X`                                               | absent, or X's own page | the browser                                                                                                  |
| An extension not in Sixkey's `ids`       | —                                                                    | —                       | **refused by the browser**, indistinguishable from "not installed" (C1, PRB M0-9 (b))                        |
| An unlisted plugin on a **surface port** | P sees Sixkey's `{id, url}`; Sixkey knows P's ID because it chose it | —                       | the browser routes the port to the ID Sixkey named (PRB M0-9 (a))                                            |
| A web page                               | —                                                                    | —                       | refused: no `matches`                                                                                        |

**The rule.** Every decision uses `sender.origin` for the frame and `sender.tab.url` for the top page. `sender.url` serves
only as a consistency check, and `pendingUrl` is never used.

### 3.3 The harvest attack, and O1

- **The attack.** If the core answered a worker's claim, `{type: "code", origin: "https://github.com"}`, any approved
  plugin could collect every registered site's code with no page open.
- **Rule O1.** Page codes go only to content scripts, and the page comes from the browser.
- **What remains:**
  - a frame of a registered site inside another page fails M4;
  - an offscreen frame has no tab;
  - a background tab or an unfocused window fails O3;
  - an idle user fails O4;
  - **a tab the plugin brings to the front while the user is there remains**, and only a card (C-b) closes it.

### 3.4 The gesture gap

- **Today** the press that makes a fill is Sixkey's.
- **For a plugin**, the press that grants page access is the plugin's (F1), and `openPopup` grants nothing (C8).
- **The core cannot see the plugin's press** (C4).
- **So if content-script requests alone sufficed**, a compromised renderer that ran the plugin's script could pull codes.

### 3.5 The design: arm, then request (O1–O4), with one meaning for a release

1. **The gesture.** The user presses the plugin's shortcut, icon or context-menu item, which grants the plugin
   `activeTab` (S13). Or a Sixkey-side action mints a **release** (item 3).
2. **The look.** The plugin's worker finds the box.
3. **The arm (O2).**
   - **What it is.** The plugin's **worker** sends `codes.arm {tab, docs, release?}`. Sixkey accepts it only with no
     `origin`, no `tab`, and `url` equal to the declared `worker` script.
   - **Its life.** 10 s, one use.
   - **When the plugin arms.** It arms from its own gestures or with a release, never because of its content script.
     That is a review item for listed plugins and a source rule for official ones.
   - **A release (V-1)** is minted by Sixkey only after a Sixkey-side action:
     - a click on an official `account.primary` entry, carried in `slot.invoked`;
     - the user's answer in Sixkey's popup, carried in `retry`.
   - **A release is bound to** the plugin, the tab, the top-level origin at that moment, and one account. It lives 10 s
     and authorises **exactly one** arm.
4. **The request.** The content script, in an armed document, sends `codes.forPage {room}`.
5. **The checks** follow SDK spec §10.6:
   - sender, approval, schema, capability, rate, availability, grant tag;
   - then arm or release, O3, O4;
   - then the card and the account (§5.3).
6. **The answer** goes through `sendResponse` to that content script only. The arm and the release are spent, and
   Sixkey's icon says _Code given to <plugin>_.

**What it buys.** A compromised renderer cannot arm, so it gets at most the code of the fill the user asked for, as
today. A release cannot be spent from another document, after a navigation to another origin, or for another account.

**What it does not buy.** The plugin itself can arm at will. That is the residual of §3.7 for official plugins, and the
reason every other plugin's `codes.forPage` goes through a card. **OQ2 (c) gives up the arm on granted sites**, because
the plugin would arm on its content script's report (R-15).

### 3.6 The closures compared

| Closure                                            | Stops a claimed origin | Stops renderer pulls | Stops a malicious approved plugin    | Cost               |
| -------------------------------------------------- | ---------------------- | -------------------- | ------------------------------------ | ------------------ |
| **C-a** content scripts only, origin from browser  | **yes**                | no                   | no                                   | none               |
| **C-b** a card per request (plugin, host, account) | yes, with C-a          | yes                  | mostly                               | one press per fill |
| **C-c** tab in front (O3)                          | —                      | narrows              | narrows                              | none               |
| **C-d** worker-only arms and bound releases (O2)   | —                      | **yes**              | no                                   | none               |
| **C-e** user active, every release shown (O4)      | —                      | —                    | narrows: none while the user is away | none               |

**Recommended.** Official plugins get C-a, C-c, C-d and C-e. Every other plugin gets all five.

### 3.7 Does the security promise regress?

- **Under I and C, no.** No code leaves Sixkey.
- **Under D, a little.** The new parties are a compromised official plugin and a same-`key` impostor, which the probe
  showed takes over the plugin's storage and grants. Both are bounded by O1–O4, one code per arm, the limits and the log.
  With `management`, the impostor loses official rights.
- **Each third party allowed codes** (Q-B) adds a residual like the official plugin's, bounded by cards and by the
  static `ids`.
- **For the platform as a whole**, see SDK spec §13.

### 3.8 A click in Sixkey's UI is a gesture Sixkey sees (F5)

- **No overlay.** Sixkey's pages cannot be framed or overlaid by pages or other extensions: Sixkey has no
  `web_accessible_resources`, and no plugin frames are allowed in version 1.
- **What the click means.** A click on a plugin entry is consent for exactly what the entry declared, for that account,
  once. With `with: ["code"]`, Sixkey adds _Gives this code to <plugin>_, and the click is the per-request confirmation.
- **What it does not do.** The click grants no `activeTab` (F1). Writes still need Sixkey's change list.
- **The interaction window.** The click opens the plugin's interaction window (§5.8).

---

## 4. Permission inventory

### 4.1 What the core holds, and what each autofill option does with it

| Item                                       | Install warning | What uses it                                                  | I (built-in plugin, B inside)                                                                 | C          | D                       |
| ------------------------------------------ | --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- | ----------------------- |
| `storage`, `unlimitedStorage`              | none            | the vault                                                     | stays                                                                                         | stays      | stays                   |
| `activeTab`                                | none            | "This site", the QR scan, autofill                            | stays                                                                                         | stays      | stays for the first two |
| `alarms`, `idle`, `offscreen`, `sidePanel` | none            | timers, the screen lock and O4, the clipboard, the side panel | stay                                                                                          | stay       | stay                    |
| `scripting`                                | none            | autofill only                                                 | **optional**: asked at the first Fill or site; Off removes it; never shown by Chrome (PRB B2) | stays      | **leaves**              |
| `clipboardRead`, `clipboardWrite`          | when asked      | clipboard clearing                                            | stays                                                                                         | stays      | stays                   |
| `https://api.sixkey.app/*`                 | none at install | sync                                                          | stays                                                                                         | stays      | stays                   |
| `https://*/*`                              | none at install | the per-site grants                                           | stays; Off removes the grants and keeps the list                                              | **leaves** | **leaves**              |
| command `fill`                             | —               | the shortcut                                                  | stays                                                                                         | stays      | **leaves**              |
| registered content script                  | —               | Stage 2's patch 3                                             | stays while `scripting` is granted                                                            | **leaves** | **leaves**              |

Under D, `inject/`, `platform/autofill*.ts`, `fill-command.ts`, `popup/main/Fill.tsx` and STORAGEGATE's gates leave the
core. The `setAccessLevel` call stays.

### 4.2 What the platform adds to the core

| Item                                                                     | Install warning                                        | Why                                                                                                                                                                                                                      | When             |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `externally_connectable: {ids: [official and listed IDs]}`, no `matches` | none [inferred]                                        | Listed plugins and their content scripts can reach Sixkey; others are refused and cannot detect it (PRB M0-9 (b)); `check-dist` pins it to the catalog                                                                   | W1               |
| Developer flavour: `ids: ["*"]`                                          | —                                                      | developers test against a separate vault                                                                                                                                                                                 | W1               |
| Surface ports to unlisted plugins                                        | —                                                      | P0 (and P1 in developer mode); opened by the surface, closed with it (PRB M0-9 (c))                                                                                                                                      | W1               |
| Optional `management`                                                    | "Manage your apps, extensions, and themes", when asked | `management.get(id)` of known plugins only: install type, version, Chrome permissions. **Trust cost:** the permission could also list, disable and uninstall extensions; the code never does, and a build rule pins that | W1, per Q-B      |
| `contextMenus`                                                           | none                                                   | the toolbar-icon slot                                                                                                                                                                                                    | later, if wanted |

**`check-dist` changes deliberately:**

- `MANIFEST_KEYS` gains `externally_connectable`, held to the catalog;
- the external-messaging rules allow only the platform's listener modules: the worker, and the popup's lazy chunk for
  "lock every time" mode;
- `OPTIONAL_ALLOWED` gains `management` (per Q-B) and `scripting` (I).

**Install warnings stay 0.**

### 4.3 The numbers

- **Package files that leave under D** (gzip −9, prod `dist/`, 2026-10-22):
  - `inject/otp.js` 5,999 B;
  - `inject/suggest.js` 594 B;
  - the Fill chunk, 5,018 + 491 B;
  - `fill-request` 889 B;
  - the Fill text, 1,239 + 1,501 B;
  - in the worker, perhaps 8–12 KB of 64.4 KB [estimate].
- **The platform's own cost** [estimate]:
  - perhaps 6–10 KB in the worker;
  - a lazy settings chunk;
  - a lazy popup chunk. Its counted glue, about 0.3–0.5 KB, comes out of the **4.3 KB of popup headroom left**.
- **Size decides nothing.**

### 4.4 A separate autofill plugin's manifest (C or D)

| Key                         | Value                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`               | C: `scripting`, `storage`. D: also `activeTab` and the `fill` command                                                                                                                                                                  |
| `optional_host_permissions` | `https://*/*`, one site at a time                                                                                                                                                                                                      |
| `externally_connectable`    | `{ids: [Sixkey's IDs]}`                                                                                                                                                                                                                |
| `web_accessible_resources`  | none                                                                                                                                                                                                                                   |
| CSP                         | `connect-src 'none'`                                                                                                                                                                                                                   |
| Storage invariant (R-18)    | nothing it stores may influence when it arms, which box it chooses, or the site list beyond list ∩ grants; `setAccessLevel(TRUSTED_CONTEXTS)` where supported. The probe shows a same-`key` copy would inherit that storage (PRB M0-8) |
| Store review                | carries K1 (S15)                                                                                                                                                                                                                       |

---

## 5. The platform, and autofill as its first official plugin

The SDK spec, [`docs/sdk/SIXKEY-PLUGIN-SDK.md`](../../sdk/SIXKEY-PLUGIN-SDK.md), is normative. This section gives the
reasons.

### 5.1 Tiers are API scopes

| Tier                       | Covers                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 Contribute**          | entries in the popup menu, the Add menu, the Settings page, the toolbar menu; theme, language, version                                                                                                                                          | **No account slot** (V-4): an account-row event would hand over a vault-derived handle and, with `thisSite`, a site match. P0 learns nothing of the lock state either, beyond the moments the user clicked its entry, when Sixkey was unlocked (§5.3, W-7)                                   |
| **P1 Read metadata**       | the account list (issuer, label, group, sites), account slots                                                                                                                                                                                   | Sensitive: the user's 2FA services, labels often email addresses. Read **only while a Sixkey surface is open and unlocked**, so polling reveals neither the lock state, nor the timer, nor the lock mode (V-5) |
| **P2 Propose changes**     | add, rename, regroup, trash, each through Sixkey's change list                                                                                                                                                                                  | Nothing is purged or replaced. **`sites.propose` is official-only** in version 1 (V-2), because one hurried confirmation of `github.com.login-check.example` would turn autofill into a phishing tool          |
| **P3 Codes**               | one per request: by a click on the plugin's entry (F5), a card, or O1–O4 for a page                                                                                                                                                             | No standing grants. Page fills without a card for official plugins only. For third parties, the default is none in version 1 (Q-B)                                                                             |
| **Never**                  | seeds, `otpauth`, exports, backups, recovery material, the master password, the PIN, the vault key, settings writes, the lock state for non-official plugins, sync, purging, direct site writes, other plugins, Sixkey's own Chrome permissions | No message exists for them                                                                                                                                                                                     |
| (default no) **Brokering** | Sixkey using its own `activeTab` for a plugin                                                                                                                                                                                                   | A confused deputy. It would hand page content over without Chrome's prompt                                                                                                                                     |

### 5.2 Trust levels, and how plugins reach Sixkey

| Level        | How Sixkey knows                                                                     | Transport                                                                                               | Ceiling (balanced preset)                         |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Official** | in the release's catalog and `ids`; with `management`, not a developer copy          | `sendMessage`, content scripts included                                                                 | P0–P3; page fills without a card; the locked flow |
| **Listed**   | in the catalog and `ids`, after a review; **its contributions pinned by hash** (V-6) | the same                                                                                                | P0–P2 (no `sites.propose`); codes per Q-B         |
| **Unlisted** | added by the user (ID or _Connect to Sixkey_)                                        | **a surface port** that the Sixkey page in use opens and closes; it lives with that page (PRB M0-9 (c)) | P0; P1 only with a developer switch (Q-B)         |
| **Blocked**  | the catalog; left out of `ids`                                                       | refused by the browser                                                                                  | nothing                                           |

- **No detection through messaging.** Runtime approval of arbitrary IDs would need `ids: ["*"]`, and every installed
  extension could then tell that Sixkey is there. With static `ids` and surface ports, no extension outside the list can
  tell through messaging (PRB M0-9 (b)).
- **What remains** (SDK spec §14):
  - extensions with `management` or `tabs`;
  - an extension that opens Sixkey's settings page by URL [unverified whether it can tell that the page loaded].

### 5.3 Autofill's `codes.forPage` checks, in order (used under D; I and C need none)

1. **The sender kind is `codeSender`** (SDK spec §10.6 step 1):
   - decisions use `sender.origin` and `sender.tab.url` only, and `url` must agree with `origin`;
   - it fails closed without `tab.url`, and never uses `pendingUrl`;
   - it needs an active, non-incognito tab and a live document;
   - schemes as `schemeOf`.
2. **Approval, schema, the capability present, the rate** (steps 2–5).
3. **The checks that need no vault** (step 5a). They come before anything that depends on the lock, so an unarmed
   request, a background tab or an idle user can never open the official lock screen (V-3):
   - **an arm**, from the declared worker, 10 s, for this tab and this document. If it carries a release, the top-level
     origin and the account must match the release's (V-1);
   - **O3**, the tab in front;
   - **O4**, `idle.queryState(30)` is `"active"`.
4. **Availability per trust level** (step 6):
   - **Official:** `locked` when locked, with the official locked flow.
   - **Any other plugin:** `waiting`, whatever the lock state.
5. **The grant store's tag verifies** (step 7, P1–P3 only).
6. **The account and the card** (V-5):
   - **Official:** exactly one registered account covering the frame and every page above it, or `no-account`,
     `choose`, `insecure`.
   - **Any other plugin:** a card first, with the plugin, its badge, the host (registrable domain emphasised) and the
     account, or the choice of accounts (V-13). A plugin learns nothing about a match before the user allowed it. With
     no match, Sixkey shows nothing and sends nothing more.
7. **The time window**, at most 5 s.
8. **The answer**, to that content script only. The arm and the release are spent, and the icon mark is shown.

**Mutants `codeSender` must kill** (R-21):

- an http page that is not an IP address, without M5's consent;
- a comparison that strips the port;
- an `about:blank` frame;
- a `url` whose origin differs from `origin`;
- a missing `tab.url`.

**Release mutants** (V-1):

- a release spent from another document;
- a release spent after a cross-origin navigation;
- a release spent for another account;
- a second arm on one release.

**An e2e assertion fails if Chrome ever scrubs `tab.url`.**

### 5.4 Locked, "lock every time", several accounts, http

- **Locked, official only**, and only once the arm or release, O3 and O4 have passed (§5.3 item 3):
  1. The core writes R and opens its popup on the lock screen: _Unlock to fill the code on github.com_. While another
     extension's popup is open, that fails (PRB M0-14), and the badge takes over (§5.8).
  2. After the popup's own unlock, it sends `retry` with a release bound to the tab, the origin and the account.
  3. The plugin arms with it and asks again.
- **Locked, any other plugin.** `waiting`. **Outside an interaction window** the badge says _A plugin is waiting for
  your answer_, and Sixkey opens nothing (V-3). **Inside one** (within 120 s of the user's click on that plugin's entry,
  §5.8), the one surface the click allows opens on the lock screen first, and the card or change list follows the unlock
  (SDK spec §6.4 item 7, W-6).
- **"Lock every time": one responder** (V-23, PRB M0-10).
  - The unlocked popup registers its own `onMessageExternal` listener in a lazy chunk, and sets `sk_plugin_responder` in
    `storage.session`.
  - While `runtime.getContexts` confirms that page is alive, the worker neither answers vault requests nor returns
    `true`. Otherwise it answers.
  - The popup ignores every other request.
  - A plugin treats `undefined` as `unavailable`.
  - **The rule is necessary:** when both contexts answer, the winner changes between runs (PRB M0-10).
  - **No internal message carries a code.**
  - **Two race tests:** the worker's quick answer against the popup's; and the popup closing between the check and the
    answer.
- **Several accounts, http.** The popup lists the accounts or asks M5's question. The answer leads to `retry` with a
  release for the account chosen.
- **"Which box?"** The plugin takes the leader, or says "type the code".
- **The card's Fill button under D** is the official `account.primary` slot.
  - The click mints a release.
  - On a new site, the plugin's own popup asks Chrome for the site in a click there. Whether that popup can open while
    Sixkey's is open: it cannot (PRB M0-14), so the plugin opens a window or asks the user to click its icon.
  - Chrome's prompt outlasts the 10 s release, so the first fill on a new site takes a second click on _Fill code_ after
    the grant. D is on the shelf, so this is a note, not a fix.

### 5.5 Slots: declarative only in version 1

- **How entries are drawn.** Sixkey draws every entry from the stored descriptor (V-6): a plain title, an icon checked to
  at most 64 × 64 (V-12), and the plugin's name with its badge.
- **Third-party entries** go only into menus.
- **Account slots need P1** (V-4).
- **Never** on the lock, PIN, password, recovery, export, confirmation, approval or _Fill anyway_ screens.
- **Embedded plugin pages are out of version 1** (V-22, PRB M0-12). A frame would be a full plugin page that can take the
  focus from a PIN field and navigate Sixkey's tab, and neither Sixkey's CSP nor `frame-src` stops it. A `sandbox` blocks
  the navigation but neither the plugin's APIs nor the focus theft. A later version could add them only with frames
  unmounted before any secret or consent screen, a `sandbox` against navigation, a sender rule for frames, and nothing
  passed in the URL (SDK spec §7.5).
- **Defaults for W1:** `popup.menu`, `account.actions`, `add.sources`, `settings.page`.
- **What the user sees:**
  - one approval screen (_Access to Sixkey_, _Access in Chrome_);
  - at most a one-line card or Sixkey's change list;
  - Settings › Plugins.

### 5.6 Approvals are security state (V-8)

- **One record.** The grant store is a single record in `storage.local`. It carries every plugin ID with its state
  (`approved`, `disabled` or `suspended`) and the reason, the stored descriptors, the grants, the developer-mode flag, an
  `epoch`, and a tag: `tag = HMAC-SHA256(HKDF(VK, "sixkey/v1/plugin-grants"), JCS(record))`.
- **When it counts.**
  - **P1–P3 grants, and drawing any entry,** count only once the tag verifies, which needs the unlocked vault key (W-8).
    Entries are drawn only while unlocked anyway, so this costs nothing, and a writer to Sixkey's storage cannot put its
    own titles under the **Official** badge.
  - **`hello`, `env.get` and the toolbar-menu items created at the last unlock** use the unverified record in every lock
    state, because they release nothing. So no P0 answer depends on the lock state.
- **Writes while locked can only tighten** (W-3). The tag cannot be recomputed while locked, so:
  - **pauses after three denials** live in `storage.session`, which survives the worker's sleep but not a browser
    restart;
  - **suspensions, disables and removals** (a changed descriptor in `hello`, a version change seen through
    `management`, the user's switch) go to an unauthenticated overlay in `storage.local` that can only suspend, disable
    or remove. It is honoured at once in every state, and merged and re-tagged at the next unlock. Whoever can write it
    can only switch plugins off; deleting it only restores the last tagged record, which is the rollback residual
    below.
- **A failed tag no longer wipes the approvals** (W-3). Sixkey keeps the record, honours no P1–P3 grant and draws no
  entry from it, and Settings › Plugins asks the user to approve each plugin again, in one click.
- **What may change silently** (W-1): only a descriptor's `version`, its descriptions and its publisher URL. Any other
  change suspends the plugin until the user approves again; a listed plugin also needs its pinned `contributionsHash`,
  whose exact input the SDK defines with a worked example (W-2, SDK spec §4.2).
- **The trust level is computed at run time**, from the catalog and `management`, and never stored.
- **Rollback.** Within a browser session, `storage.session` holds the last epoch and refuses older records. Across a
  restart, a writer to Sixkey's storage could restore an older record. `TRUSTED_CONTEXTS` (Chrome 140+) and STORAGEGATE
  (120–139) already deny such a writer to pages.
- **Device-local.** Never synced, backed up or exported. The vault syncs, and plugins are per profile.

### 5.7 Brokered page access: no (default)

- **What it would mean.** Sixkey captures a page with its own `activeTab` and hands it over.
- **Why not.** That makes Sixkey a confused deputy, and the plugin's access would bypass Chrome's prompt.
- **The screenshot tool instead** uses its own icon, shortcut or context-menu item, or its own `<all_urls>`, which Chrome
  warns about.

### 5.8 Plugins cannot open Sixkey's windows at will (V-3)

- **What would happen otherwise.** A plugin could time a card under the user's cursor, or make Sixkey ask for the PIN
  during a screen share. So Sixkey opens a surface for a plugin only:
  - **(a) once, within 120 s after the user clicked one of that plugin's entries in Sixkey** (the interaction window),
    and **only the surface that the clicked entry's slot allows** (W-11):
    - an entry in the Add menu: the change list for adding accounts. That covers the import flow, where _Import_ is
      followed by the plugin's file picker and then Sixkey's change list;
    - an entry on an account: a card for that account's code, or a change list for that account;
    - an entry in the popup menu, the Settings page or the toolbar menu: nothing;
  - **(b) the official locked flow.**
- **Otherwise only the badge `!`**, also when a popup should open but cannot, because any extension's popup is open
  (PRB M0-14). The card or a _Review_ link waits for the next time the user opens Sixkey, for up to
  5 minutes.
- **Every card and change list:**
  - ignores input for 600 ms after it appears or regains focus;
  - has no default button;
  - is spaced: at most one opening every 30 s and 6 an hour per plugin, lock-screen openings included;
  - three denials pause the plugin, until the user resumes it or the browser restarts.

---

## 6. Effect on OWNER-DECISIONS/14

| Question                                   | I (and B)                                                                     | C                                                                                                                                                              | D                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OQ1** Chrome 140                         | unchanged                                                                     | unchanged for the core; the companion keeps the storage invariant                                                                                              | moot for the vault                                                                                                                                                         |
| **OQ2** one click on an in-page suggestion | unchanged (it now also covers v2's MQ5)                                       | patch 4 cannot fill through Sixkey's popup (C8): the suggestion says _Click the Sixkey icon_, or codes cross (D's API), or the core keeps its grants (K1 back) | carries over: (b) Sixkey's popup confirms, then `retry` with a release; (c) the plugin arms on its content script's report, which **gives up C-d on granted sites** (R-15) |
| **OQ3** store wording, draft upload        | unchanged; plus B's wording and, at W2, the data-transfer wording (v2's MQ12) | moves to the companion                                                                                                                                         | moves to the plugin; the core keeps the data-transfer wording                                                                                                              |
| **K1**                                     | the core's                                                                    | the companion's                                                                                                                                                | the plugin's                                                                                                                                                               |

---

## 7. Plan

**Costs** are in agent-days and review rounds (REV §4) [estimate]. Calendar time comes on top: the owner's own use, the
store's review, and owner decisions.

### 7.1 Waves

| Wave   | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Agent-days, rounds             | Kill criterion                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0** | **Done** (§1.6), including M0-9 (d) and (e), M0-12's positive control and `sandbox` variants, and B2's Site access line. Since then also M0-9 (f), M0-14 and M0-8 with site access and CDP Load unpacked. Still open, none of which can change the verdict:<br>- whether M0-13's opener can tell that Sixkey's page loaded;<br>- M0-8 through the Load unpacked button and store installs;<br>- in headed Chrome, where a popup swapped in for Sixkey's is anchored (§10). | 0.5 more                       | **KW-0** did not fire: M0-9 holds                                                                                                            |
| **W1** | **Platform v1:**<br>- the listener with one responder;<br>- the order of checks;<br>- `hello` and its tolerant descriptor;<br>- the grant store and its tag;<br>- the approval screen, Settings › Plugins, Add by ID and _Connect to Sixkey_ (untrusted fragment);<br>- surface ports;<br>- the catalog and `ids`;<br>- the four P0/P1 slots;<br>- `env.read`, the request log;<br>- the SDK package with `fakeSixkey`;<br>- the samples (password generator, screenshot launcher);<br>- the e2e harness, with raw CDP for sleep.<br>**Plus autofill as the built-in official plugin (I).** | 6–10, 5–7                      | **KW-1:** the popup cannot keep 1,500 B headroom with the slot glue, or the owner finds approval complicated in his own use → simplify first |
| **W2** | P1 (surface-bound) and P2 (`add`, `update`, `trash`) with Sixkey's change list and the interaction window; the import sample; the data-transfer wording approved (file 06, OQ3)                                                                                                                                                                                                                                                                                                                                                                                                             | 2–4, 2                         | **KW-2:** a write path that can lose or replace data, or skip the change list → stop the write tier                                          |
| **W3** | **Only if needed:**<br>- codes for listed plugins (Q-B variant), with cards, `waiting` and releases;<br>- or option C or D for autofill.<br>Under the recommended Q-A (a) with "balanced", **W3 is not needed**.                                                                                                                                                                                                                                                                                                                                                                            | 2–3 (codes); C 2–4; D 4–7, 6–9 | **KW-3:** a code obtainable without a browser-recorded origin, an arm or release, an active user, a click in Sixkey or a card → stop         |

### 7.2 Option I in detail: autofill as the built-in official plugin

1. **The boundary.**
   - Autofill reaches the vault only through the platform's capability gate, with the same log and the same switch, and
     a source rule enforces it.
   - The external-sender rules (O1, O2) apply only if it moves out.
2. **Settings › Plugins** lists _Autofill · Official · Built in_ with **On/Off**. Settings › Security › Autofill becomes
   its page.
3. **`scripting` becomes optional** (R-8):
   - the first Fill click requests it, which Chrome grants with no dialog (C11);
   - turning on a site asks `{permissions: ["scripting"], origins: [pattern]}` in one request;
   - every `chrome.scripting` use is guarded;
   - the worker reconciles on events that name `scripting`;
   - the shortcut checks `contains` and opens the popup when it is missing;
   - e2e covers a site turned on before the first Fill, Off then On, and the shortcut before the grant.
4. **Off removes `scripting` and the site grants**, keeping the list for a later On (R-9).
5. **What it does not promise.** Chrome's details page never lists `scripting` (PRB B2). The gain is for auditors (the
   manifest, PRIVACY), not for what a user can see.

**Cost:** 1–2 agent-days, 2–3 rounds.

### 7.3 Option D in detail (only if Q-A (c))

| Patch  | Contents                                                                                                                                                                    | Kill criterion                                                                                           | Agent-days, rounds |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| **M0** | the remaining probes, plus: the plugin's command → `executeScript` → `codes.forPage`; one dialog for several origins; whether removing `https://*/*` revokes grants (M0-11) | **KS-1:** a §3.2 field not as read; or the impostor keeps host grants and Q-B has no `management` → stop | 0.5–1              |
| **M1** | the second package, its manifests, budgets and IDs                                                                                                                          | —                                                                                                        | 0.5–1, 1           |
| **M2** | `codes.forPage`, `page.candidate`, `ui.badge` for an external plugin; §5.3's mutants and the release mutants                                                                | **KS-2:** a code without a browser-recorded origin, an arm or a bound release → stop                     | 1–2, 2–3           |
| **M3** | the plugin at parity with the five autofill e2e specs; the arm call-site rule; the storage invariant                                                                        | **KS-3:** no parity → stop, keep I                                                                       | 1–2, 1–2           |
| **M4** | the owner's own use                                                                                                                                                         | **KS-4:** worse → stop                                                                                   | ≥ 1 week           |
| **M5** | the store                                                                                                                                                                   | **KS-5:** rejected, or held more than 14 days → keep I                                                   | calendar           |
| **M6** | the migration release, with no site hand-over (R-22); the built-in fill kept as the fallback                                                                                | —                                                                                                        | 0.5–1 with M7, 1   |
| **M7** | the removal release                                                                                                                                                         | **KS-6:** a regression → revert                                                                          | (with M6), 1       |

**Total:** 4–7 agent-days and 6–9 rounds, plus M4 and M5.

### 7.4 What is never removed early

The built-in autofill keeps working until any replacement has passed parity, the owner's use and the store's review.
Under I and C nothing is removed.

### 7.5 Changes outside this study, if it is adopted (listed, not made here)

- **`REUSE.toml`:**
  - `contract/plugin-sdk/1/**` (the schemas) as contract data, CC0-1.0;
  - `contract/plugin-sdk/**` code (the TypeScript package) as contract code, Apache-2.0, following OWNER-DECISIONS/01.
- **`extension/scripts/check-dist.mjs`:**
  - `MANIFEST_KEYS` gains `externally_connectable`, generated from the catalog;
  - the external-messaging rules are limited to the platform's listener modules;
  - `OPTIONAL_ALLOWED` gains `scripting` (I) and, per Q-B, `management`.
- **`docs/PRIVACY.md`:** the plugin data-transfer paragraph (file 06, 14 OQ3).
- **`docs/ARCHITECTURE.md` §4:** the plugin boundary.
- **`docs/security/local-vault.md`:** the grant store and the Permissions table.
- **`TRADEMARKS.md`:** the plugin-name rule (file 03).

---

## 8. Distribution

- **Official external plugins** (only under Q-A (b) or (c), or if the showcase tools are published):
  - each is its own store listing, under the publisher account;
  - the account's security belongs to OWNER-DECISIONS/07, which already defers it until after file 06's trial;
  - names follow file 03.
- **The built-in plugin** has no listing.
- **Finding plugins.** Settings › Plugins lists the release's catalog with **Get** links. Nothing is fetched, and nothing
  is pushed at install (S8).
- **Unlisted plugins** are added by ID or _Connect to Sixkey_. The fragment only navigates and pre-fills (PRB M0-13).
- **Missing, disabled, outdated** (SDK spec §9.6):
  - missing and disabled look the same without `management`;
  - a developer copy shows as such only with `management`;
  - a listed plugin changed since review is suspended until a release.
- **Compatibility.** `sdkVersion` is an integer. The descriptor is read tolerantly (SDK spec §5.3), and one release of
  overlap is kept for every version.

---

## 9. Alternatives, kill criteria and the verdict

### 9.1 Options for autofill

| Option                                           | What it is                                                              | What the user sees                                                                            | Security against today    | Effort [estimate]                            |
| ------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------- |
| **A** Built in (today)                           | as merged; patch 4 paused                                               | one extension; Fill, shortcut, badge                                                          | the baseline              | 0                                            |
| **B** Built in, `scripting` optional             | §7.2 item 3                                                             | the same; nothing visible in Chrome (PRB B2)                                                  | the same                  | 0.5–1 day, 1–2 rounds                        |
| **I** Built-in official plugin (**recommended**) | B plus the boundary and the plugin row                                  | the same, listed as a plugin                                                                  | the same                  | 1–2 days, 2–3 rounds                         |
| **C** Companion for suggestions                  | Stage 2's per-site part in a companion that sends only `page.candidate` | Stage 1 unchanged; suggestions need a second install; patch 4 becomes "click the Sixkey icon" | the same: no code crosses | 2–4 days, 2–3 rounds; a second store item    |
| **D** Full split                                 | §7.3                                                                    | two extensions; a Chrome prompt per new site; the shortcut moves                              | a small regression (§3.7) | 4–7 days, 6–9 rounds; ≥ 1 week; store review |

### 9.2 Kill criteria

- **The waves:** KW-0 to KW-3.
- **D:** KS-1 to KS-6.
- **Prefer I over D** if a Chrome prompt per new site matters to the owner, or if Q-B has no `management` (an impostor
  keeps the grants: PRB M0-8).
- **Prefer C over I** if K1 fires on the core and the owner wants per-site suggestions.

### 9.3 The direct answers on option B

1. `scripting` can be optional.
2. No dialog: C11.
3. The shortcut opens the popup before the grant.
4. STORAGEGATE is unaffected.
5. Chrome's UI never shows the difference (PRB B2).
6. The naive version breaks patches 2 and 3; §7.2 fixes that.

### 9.4 The verdict

- **The platform is what the owner asked for, and it does not need autofill to move.** It needs a first official plugin,
  and I is the cheapest one that keeps every promise and the Fill button everywhere.
- **D's daily costs** (F1, C8, F4) outweigh what it buys (K1 off the core, "no content scripts", OQ1 moot).
- **Third-party codes** are the riskiest part, and no third-party use for them exists yet, so the balanced default leaves
  them out of version 1. A release can add them later for a reviewed plugin with a real use.
- **Recommendation:** Q-A (a), with the showcase tools as samples first; and Q-B "balanced".

---

## 10. Threats introduced by the platform

SDK spec §13 is the full table. The autofill rows under D:

| Threat                                                          | Defence                                                                                | Residual                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| An extension not in `ids`                                       | refused by the browser (C1, PRB M0-9)                                                  | none known                                                                                 |
| The plugin's worker claims a page                               | O1                                                                                     | none known                                                                                 |
| A compromised renderer impersonates the plugin's content script | O2: worker-only arms, armed only from the plugin's gestures or a bound release; O3; O4 | the code of the fill it hosts; under OQ2 (c) the arm's protection is gone on granted sites |
| A release reused elsewhere                                      | one arm, 10 s, bound to the tab, the origin and the account (V-1)                      | none known                                                                                 |
| The plugin brings a registered site to the front                | O3, O4, the icon mark, limits, the log                                                 | **a compromised or impostor official plugin, while the user is at the computer**           |
| A plugin adds a site so that autofill fills there               | `sites.propose` is official-only (V-2)                                                 | none for third parties                                                                     |
| An impostor carrying the official `key`                         | `management` (Q-B)                                                                     | **without it, the impostor takes over the storage and grants (PRB M0-8)**                  |
| Popup-jacking by plugin requests                                | §5.8                                                                                   | a user who clicks through after the delay                                                  |
| Any extension swaps its popup in for Sixkey's (not new with the platform) | Sixkey asks for a password or PIN only in its own window, as the approval screen says; in headed Chrome the replacement should sit under the other extension's icon [unverified] | **low to medium:** a foreground `tabs.create`, with no permission and no gesture, closes Sixkey's popup, and the extension's own popup opens about 370 ms later (PRB M0-14, 7c); a failing `openPopup()` tells it that some popup is open. The platform gets users used to plugin popups next to Sixkey |
| The plugin's storage written by a renderer on Chrome 120–139    | the storage invariant                                                                  | none known, with the invariant                                                             |

---

## 11. Unverified claims, and what has been settled

| #   | Claim                                                                        | Status                                                                                                                |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Optional host patterns do not appear in the install prompt                   | [unverified]; needs a packed install                                                                                  |
| 2   | B1: no dialog for `scripting`                                                | **verified in source** (C11)                                                                                          |
| 3   | The worker may call `permissions.request` from `commands.onCommand`          | [unverified]                                                                                                          |
| 4   | `--load-extension` takes comma-separated lists                               | **probed: yes** (PRB M0-8: `A,B`)                                                                                     |
| 5   | Two extensions suggesting the same shortcut                                  | verified in the docs [transcribed: REV]                                                                               |
| 6   | The store accepts a `key` in an upload                                       | [unverified]; prod builds omit it                                                                                     |
| 7   | A sandboxed extension frame gets its own process                             | [unverified]; moot                                                                                                    |
| 8   | How the store's data form treats codes or names handed to a plugin           | partly settled by Limited Use (S22)                                                                                   |
| 9   | One `permissions.request` with several origins shows one dialog              | [unverified]                                                                                                          |
| 10  | Missing and disabled extensions give the same error                          | missing and listener-less **probed** (PRB M0-9 (b)); disabled **verified in source** [transcribed: REV row 6]         |
| 11  | Unpacked extensions when Developer mode is turned off                        | [unverified]                                                                                                          |
| 12  | `externally_connectable` or optional `management` affects store review       | [unverified]; listed in Q-A's costs                                                                                   |
| 13  | Registered content scripts survive the removal of `scripting`                | [unverified]; §7.2 unregisters first                                                                                  |
| 14  | Storage calls from a renderer that never ran Sixkey's script are refused     | [inferred] from C2                                                                                                    |
| 15  | "One ID cannot be installed twice, so an impostor needs the original absent" | **wrong** (C9, C10); the impostor takes over (PRB M0-8)                                                               |
| 16  | A worker may hold `sendResponse` for up to 5 s                               | [unverified]                                                                                                          |
| 17  | The store updates two items independently                                    | [inferred]                                                                                                            |
| 18  | Sixkey's listener dropping a message is observable                           | **probed**: only a listener that never answers is distinguishable (PRB M0-9 (b)); with static `ids` it does not arise |
| 19  | `commands.getAll` returns only the caller's commands                         | verified in the docs [transcribed: REV]                                                                               |
| 20  | `frame-src` gates extension frames                                           | **probed: it does not** (PRB M0-12): a `data:` frame on the same page is blocked, an extension frame is not, also under `frame-src 'none'`; `sandbox` blocks navigation only |
| 21  | `management.get` for another ID on Chrome 120                                | [unverified]                                                                                                          |
| 22  | A message from Sixkey wakes a stopped plugin worker                          | **probed, indirectly:** a message from another extension's page woke a stopped receiver (PRB M0-9 (d)); from Sixkey's worker [inferred] |
| 23  | M0-8: a same-`key` copy keeps storage and grants                             | **probed: yes**, for `storage.local`, optional API permissions and site access, under command-line installs and CDP Load unpacked; the button and store installs unsimulated |
| 24  | M0-9: Sixkey-opened ports                                                    | **probed: they work**; they die 30 s after the last message, the opener is not woken, and an idle port keeps neither end alive (M0-9 (e)) |
| 25  | M0-10: two listeners                                                         | **probed:** the first `sendResponse` wins, and which one is first changes between runs; `return true` with no answer hangs and keeps the receiver alive (M0-9 (d)) |
| 26  | M0-11: removing an optional host pattern revokes grants                      | [unverified]                                                                                                          |
| 27  | M0-13: another extension opens Sixkey's settings page                        | **probed: yes, by `tabs.create` and `windows.create`**; `tabs.update` is blocked; Sixkey cannot learn the opener; whether the opener can detect the load is open |
| 28  | B2: Chrome's details page shows `scripting`                                  | **probed: never**; the Site access line comes from `activeTab` (PRB B2)                                               |
| 29  | `idle.queryState` accepts 30 s                                               | [unverified]                                                                                                          |
| 30  | M0-14: a plugin opens its own popup while Sixkey's is open                   | **probed: no** without a gesture, even in answer to Sixkey; but a foreground tab closes Sixkey's popup first, and then it can (7c) |
| 34  | In headed Chrome, a swapped-in popup is anchored under its own extension's icon | [unverified]; a probe for headed Chrome (§10)                                                                       |
| 31  | `commands.getAll`'s shortcut text on macOS (symbols or words)                | [unverified]; the SDK's shortcut grammar accepts both                                                                 |
| 32  | M0-9 (f): a pending `sendMessage` keeps its sender alive                     | **probed: yes**. The auto-lock is an alarm (`sw.ts`), so it costs memory and delays no lock [inferred]                |
| 33  | Chrome's Chinese text for the `management` warning                           | [unverified]; the English is "Manage your apps, extensions, and themes" (S10)                                         |

---

## 12. The owner's decisions

Two decisions, each with a default. They are phrased so that they can be translated into a Chinese OWNER-DECISIONS file
as they stand. Everything else is a default or belongs to an existing file (§12.3).

### Q-A. Should Sixkey get a plugin platform, and where does autofill live?

**What a platform costs, whichever of (a)–(c) is chosen:**

- **A public interface is a long-term promise.** Other people build on it, so every change must stay compatible, with at
  least one release of overlap.
- **If Q-B lets other people's plugins in, every reviewed one is a security review** by the project, repeated for as long
  as it is listed.
- **A vault extension gains attack surface:** messages from other extensions, confirmation cards, change lists, and
  links between extensions.
- **The popup has about 4.3 KB of space left.** Plugin code must load only when used.
- **The store may look harder** at the new manifest key and at the optional "manage extensions" permission [unverified].

**What (d) gains:** no new surface, and all effort stays on the authenticator. Under (d), Q-B does not arise.

| Option                         | What it means                                                                                                                                                                                                                                                                                             | Cost [estimate]                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **(a)** (recommended, default) | **Build the platform in waves.** Autofill becomes a built-in official plugin: Settings › Plugins shows _Autofill · Official · Built in_ with a switch. Its page-script permission is held only after first use, and Off removes it and the sites you allowed. The Fill button keeps working on every site. **Gain:** one extension, and filling works as it does today | W1 with autofill: about 6–10 agent-days and 5–7 review rounds; W2 2–4 days                       |
| (b)                            | The same, but the per-site suggestions move to an official companion extension. People who want suggestions install a second extension. The paused one-click fill in the page would become "click the Sixkey icon". **Gain:** the store's longer review of access to all sites moves off Sixkey | (a) plus 2–4 days, and a second store item                                                       |
| (c)                            | The same, with autofill as a fully separate Sixkey Autofill extension. Filling on a new site asks Chrome once for that site; the shortcut moves to it; codes pass between the two extensions. **Gain:** Sixkey itself runs no scripts in web pages, the store's review of access to all sites moves to the autofill extension, and the Chrome 140 question (OWNER-DECISIONS/14 OQ1) no longer matters for the vault | (a) plus 4–7 days and 6–9 review rounds, at least a week of your own use, and the store's review |
| (d)                            | No platform. Autofill stays as it is, optionally with its page-script permission held only after first use (half a day to a day)                                                                                                                                                                          | 0 to 1 day                                                                                       |

**A related choice: the two example tools** (the password generator and the full-page screenshot tool):

- **(i) Publish them as official plugins.**
  - **Gain:** users can get them from the store, and they show what the platform does.
  - **Cost:** two more store items under the publisher account, each with its own review. The screenshot tool asks
    Chrome for wide page access under Sixkey's name.
- **(ii) Keep them as examples in the repository for now** _(default)_, and decide after you have used them in W1.

### Q-B. How open should Sixkey be to plugins made by other people?

Three presets. Each one sets all the third-party switches at once (the full list is in §12.2).

| Preset                              | Plugins by others: buttons                                                                    | Reading account names and proposing changes                                                         | Verification codes for others' plugins    | Developer switch in the store version | Checking for developer copies (`management`)           | Block list                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| **Closed start**                    | no: official plugins only, others in a later release                                          | official only                                                                                       | no                                        | no                                    | not needed                                             | in each release                                               |
| **Balanced** (recommended, default) | yes: reviewed ones appear by themselves; others you add (paste an ID, or _Connect to Sixkey_) | reviewed plugins only, each change confirmed by you in Sixkey; proposing a site stays official-only | **no in version 1**                       | not in W1; decide after W1            | asked when you enable the first plugin by someone else | in each release                                               |
| **Open**                            | yes, anyone you approve                                                                       | anyone you approve, each change confirmed                                                           | reviewed plugins, every request confirmed | yes                                   | asked                                                  | in each release, plus an optional download (uses the network) |

**What each preset gives and costs:**

- **Closed start.**
  - **Gain:** the smallest attack surface and nothing to review.
  - **Cost:** "people can build tools" waits for a later release.
- **Balanced.**
  - **Gain:** anyone can add buttons and tools; reviewed tools can read names and propose changes. Other extensions
    still cannot detect Sixkey **through extension messaging**. An extension with Chrome's `tabs` or `management`
    permission, or one that opens Sixkey's settings page, may still notice that Sixkey is installed.
  - **Cost:** the project reviews each listed plugin. Plugins you add by ID get buttons only.
  - **Cost of the `management` check:** when you enable the first plugin by someone else, Chrome asks you to allow
    "Manage your apps, extensions, and themes". From then on the vault extension could list, turn off and remove your
    other extensions. Sixkey's code never does, and a build rule pins that, but you have to trust it.
- **Open.**
  - **Gain:** the widest choice.
  - **Cost:** every installed extension can tell that Sixkey is installed, approvals can be talked into, and the optional
    download is Sixkey's first network call without sync. The `management` cost of "balanced" applies too.

**Inside "balanced", one sub-choice, asked neutrally: verification codes for other people's plugins.**

| Option                                        | Gains                                                                                                                                                                                                                                                                               | Costs                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Never in version 1** _(default)_            | Nothing of the third-party code path is built (about 2–3 days and 2–3 review rounds saved). No plugin can ever cause a code card. The information leaks of that path cannot arise. A later release can add it for a reviewed plugin with a real use, without changing anything else | A third-party tool that needs codes (a watch or desktop bridge, say) cannot exist yet                                     |
| **Reviewed plugins, every request confirmed** | Such tools become possible                                                                                                                                                                                                                                                          | The work above. More cards for the user. A reviewed plugin, or a malicious update of one, gets every code the user allows |

**Never offered in any preset:**

- Sixkey lending its own page access to a plugin (brokering);
- standing "always allow" for codes.

### 12.2 The switches each preset sets (for an owner who wants to change one)

| Switch                                                           | Closed start    | Balanced                                       | Open                      |
| ---------------------------------------------------------------- | --------------- | ---------------------------------------------- | ------------------------- |
| S-1 Buttons (P0) for third parties                               | no              | yes                                            | yes                       |
| S-2 P1–P2 for third parties                                      | no              | reviewed only                                  | anyone approved           |
| S-3 Codes (P3) for third parties                                 | no              | no in version 1 (sub-choice)                   | reviewed, confirmed       |
| S-4 How third parties get in                                     | a later release | reviewed in the release list; others by ID, P0 | `ids: ["*"]` (detectable) |
| S-5 Developer switch in the store version (P1 for added plugins) | no              | after W1                                       | yes                       |
| S-6 Optional `management`                                        | no              | at the first third-party plugin                | yes                       |
| S-7 Downloaded block list                                        | no              | no                                             | optional, off by default  |
| S-8 Brokering of Sixkey's page access                            | no              | no                                             | no                        |

### 12.3 Defaults, and items that belong to existing files

| Item (v2)                                                                                                 | Where it goes now                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQ1a, MQ1b, MQ2                                                                                           | **Q-A**                                                                                                                                                         |
| MQ3, MQ4, MQ8–MQ11                                                                                        | **Q-B**                                                                                                                                                         |
| MQ5 (one click on an in-page suggestion)                                                                  | **OWNER-DECISIONS/14 OQ2**, not repeated                                                                                                                        |
| MQ6: the publisher account and its second factor                                                          | **OWNER-DECISIONS/07**, which already defers the account until after file 06's trial                                                                            |
| MQ6: plugin names and the trademark rule ("for Sixkey" allowed; not starting with "Sixkey"; not the icon) | **OWNER-DECISIONS/03** and `TRADEMARKS.md`; it matters only once third parties or official external plugins exist                                               |
| MQ6: the samples                                                                                          | the sub-choice of Q-A                                                                                                                                           |
| MQ7 (which slots first)                                                                                   | **a default:** popup menu, account menu, Add menu, Settings page; the owner can change it during his own use of W1                                              |
| MQ8 (brokering)                                                                                           | **a default:** no                                                                                                                                               |
| MQ12 (data-transfer wording)                                                                              | **OWNER-DECISIONS/06** with **14 OQ3**, approved at W2                                                                                                          |
| MQ13 (the SDK's licence)                                                                                  | **settled by OWNER-DECISIONS/01:** the schemas are contract data (CC0-1.0); the TypeScript package, under `contract/plugin-sdk/`, is contract code (Apache-2.0) |

---

## 13. Sources

Chrome documentation and the Chrome Web Store (read 2026-10-23):

- S1 runtime API: <https://developer.chrome.com/docs/extensions/reference/api/runtime>
- S2 `externally_connectable`: <https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable>
- S3 messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>
- S4 content security policy: <https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy>
- S5 sandbox: <https://developer.chrome.com/docs/extensions/reference/manifest/sandbox>
- S6 `userScripts`: <https://developer.chrome.com/docs/extensions/reference/api/userScripts>
- S7 CWS MV3 requirements: <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- S8 CWS program policies: <https://developer.chrome.com/docs/webstore/program-policies/policies>
- S9 manifest `key`: <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- S10 permissions list: <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- S11 permission warnings: <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- S12 permissions API: <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- S13 activeTab: <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- S14 Hello World (Load unpacked): <https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world>
- S15 CWS review process: <https://developer.chrome.com/docs/webstore/review-process>
- S16 `web_accessible_resources`: <https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources>
- S17 management API: <https://developer.chrome.com/docs/extensions/reference/api/management>
- S18 tabs API: <https://developer.chrome.com/docs/extensions/reference/api/tabs>
- S21 idle API: <https://developer.chrome.com/docs/extensions/reference/api/idle>
- S22 CWS Limited Use: <https://developer.chrome.com/docs/webstore/program-policies/limited-use>

Other platforms:

- S19 Android permissions overview: <https://developer.android.com/guide/topics/permissions/overview>
- S20 VS Code extension runtime security:
  <https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security>

Chromium source, `main`, at `https://github.com/chromium/chromium/blob/main/<path>` (read 2026-10-23):

- C1 `extensions/browser/api/messaging/message_service.cc`
- C2 `extensions/browser/api/messaging/message_service_bindings.cc`
- C3 `chrome/browser/extensions/api/messaging/chrome_messaging_delegate.cc`
- C4 `extensions/renderer/api/messaging/native_renderer_messaging_service.cc`
- C5 `extensions/renderer/api/messaging/messaging_util.cc`
- C6 `extensions/browser/permissions/active_tab_permission_granter.cc`
- C7 `components/crx_file/id_util.cc`
- C8 `chrome/browser/ui/extensions/extension_action_view_model.cc`
- C9 `extensions/common/manifest.cc`
- C10 `extensions/browser/extension_registrar.cc`
- C11 `extensions/browser/api/permissions/permissions_api.cc`

Probes and reviews (in `scratchpad/mod-study/`):

- **PRB** `probes/RESULTS.md` and `probes/results/*.log`: Chromium 156.0.8078.4, Playwright 1.64.1, command-line
  installs, 2026-10-23.
- **REV** `MOD-PLATFORM-REVIEW.md`, the review of v1.
- **REV2** `MOD-PLATFORM-V2-REVIEW.md`, the review of v2; its §6 is the verification of v3 (W-n, GAP-n).

This repository: the manifests, `scripts/check-dist.mjs`, `scripts/store-id.mjs`, `src/platform/sender-policy.ts`,
`autofill.ts`, `autofill-register.ts`, `fill-request.ts`, `api-permission.ts`, `src/popup/main/Main.tsx`, `scan.ts`,
`src/sidepanel/guard.ts`, `src/background/sw.ts`, `fill-command.ts`, `src/core/vault/model.ts`, `validate.ts`, the tests
named in §1.5, `docs/design/proposals/TOTP-AUTOFILL.md`, `docs/design/notes/AUTOFILL1-NOTES.md`, `AUTOFILL2-NOTES.md`,
`docs/security/local-vault.md`, `docs/ARCHITECTURE.md`, `TRADEMARKS.md`, `REUSE.toml`, `OWNER-DECISIONS/01`, `03`, `06`,
`07`, `11`, `14`.

---

## Appendix W. The verification of v3: findings and what was done

The source is REV2 §6. No finding is rejected. "SDK" means `docs/sdk/SIXKEY-PLUGIN-SDK.md` 1.0-draft.4. The GAP-n
checks are the reviewer's schema probes, re-run against draft.4 by `check_sdk.py` and the reviewer's own script.

| W    | Severity            | Finding (short)                                                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-1  | Medium              | The descriptor changes that suspend are a denylist that misses fields   | **Fixed.** An allowlist: only `version`, `description`, `locales.*.description` and `publisher.url` change silently. Everything else suspends, `publisher.name`, `worker`, `sdkVersion`, `sdkMin`, `defaultLocale`, `locales.*.name` and `locales.*.reasons` included. Descriptors are compared after normalisation, so a tolerated unknown field changes nothing (§5.6; SDK §4.2 item 2) |
| W-2  | Medium              | `contributionsHash`'s input is not exact                                 | **Fixed.** `SHA-256(JCS({"contributions": C, "titles": T}))`, lowercase hex. C holds the surviving contributions, reduced to the version-1 fields, unknown fields removed, PNG data included, sorted by `id`; T holds the titles per locale for those IDs. A worked example with its hash; the validator reproduces it (SDK §4.2 item 3)                                                         |
| W-3  | Medium, before W1   | No state field; nothing says how to write while locked                  | **Fixed.** Each entry has `state` and `reason`. Pauses after denials live in `storage.session`. Suspensions, disables and removals while locked go to an unauthenticated overlay that can only narrow, honoured at once and merged and re-tagged at the next unlock. A failed tag keeps the record and asks for re-approval; nothing is wiped. Conformance cases (§5.6; SDK §6.4, §6.6, §16.1) |
| W-4  | Medium, before W1   | New values, not only new fields, break `hello`                          | **Fixed.** New SDK §4.3: a capability request, contribution or locale entry that fails validation, is unknown, or repeats an earlier one, is dropped and listed in `unavailable` (`capability:`, `contribution:`, `locale:`). The descriptor fails only on a required top-level field. Envelopes stay strict. Conformance cases for each GAP (SDK §4.1, §4.3, §16.1)                         |
| W-5  | Low, before W2      | `waiting` is both a success and an error                                | **Fixed.** `waiting` is an error for `codes.forPage` only; P2 and `codes.get` always answer `pendingResult`. A schema cannot pair a response with its request type, so the SDK client checks it, with a conformance case (SDK §6.3, §10.3, §10.6, §10.7, §12.4)                                                                                                                              |
| W-6  | Low                 | Study and SDK disagree on a locked surface for a non-official plugin    | **Fixed** in the SDK's direction: nothing opens outside an interaction window; inside one, the allowed surface opens on the lock screen first (§5.4)                                                                                                                                                                                                                                         |
| W-7  | Low                 | Residual learning is not stated                                         | **Stated.** A P0 click implies an unlocked Sixkey at that moment; the timing of `request.done` tells P2 and P3 roughly when the user next opened Sixkey; conformance reads "rolled back within a browser session" (§5.1; SDK §10.6, §16.1)                                                                                                                                                     |
| W-8  | Low–Medium          | Entries can be drawn from an unverified record under the Official badge | **Fixed.** No entry is drawn before the tag verifies. The unverified path keeps only `hello`, `env.get` and the `action.menu` items created at the last unlock (§5.6; SDK §4.2 item 1, §6.6 item 3)                                                                                                                                                                                          |
| W-9  | Low                 | `keys` is a character set, not the shortcut grammar                     | **Fixed.** Chrome's `suggested_key` grammar: one to three modifiers and one key name, the media keys, or the macOS symbol form ([unverified], §11 item 31). A value outside it, "Type PIN in next window" for one, is ignored and never drawn; it no longer invalidates `hello` (SDK §5.1, `#/$defs/shortcut`)                                                                               |
| W-10 | Nit                 | "Draws only while unlocked" conflicts with the `action.menu` exception  | **Fixed** in the wording (SDK §4.2 item 1)                                                                                                                                                                                                                                                                                                                                                   |
| W-11 | Low, optional       | The interaction window is wider than the click's consent                | **Done.** The window allows only what the clicked slot allows: the Add menu, a change list for adding; an account, a card or change list for that account; the popup menu, Settings page and toolbar menu, nothing. Conformance case (§5.8; SDK §6.4 item 1, §16.1)                                                                                                                       |

**The schema gap checks** (draft.4):

| GAP   | Check                                                  | Now                                                                                                                         |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GAP-1 | free text in `keys`                                    | `hello` stays valid, by design; the value fails `#/$defs/shortcut` and is ignored (W-9)                                     |
| GAP-2 | an unknown builtin icon                                | `hello` valid; that contribution is dropped and listed (W-4)                                                                |
| GAP-3 | a future icon kind                                     | the same                                                                                                                    |
| GAP-4 | a future `when.vault` value                            | the same                                                                                                                    |
| GAP-5 | unknown fields                                         | tolerated, as before                                                                                                        |
| GAP-6 | no state in `grantStore`                               | `state` and `reason` added, with `grantOverlay` and `pluginPauses` (W-3)                                                    |
| GAP-7 | `waiting` as an error for any request                  | still accepted by the schema, which cannot see the request type; the SDK client and a conformance case check it (W-5)      |
| GAP-8 | a release in an `account.actions` event                | **refused**: the schema allows a release in `account.primary` events only                                                   |
| GAP-9 | a repeated capability name                             | the schema cannot express uniqueness by name; §4.3 drops the second occurrence, and the validator tests it                  |

**The follow-up probes** (REV2 §6.4) are folded into §1.6, §5.4, §5.5, §7.1 and §11, and into SDK §3.3, §7.5, §9.2 and
§14. The late results of M0-9 (f), M0-14 and M0-8 (site access, CDP Load unpacked) are folded in the same way (§1.6,
§5.4, §5.8, §11; SDK §3.3, §6.4, §8.2, §12).

**Not done here:** OWNER-DECISIONS/16 is being corrected by its author (REV2 §6.5). The study's §12 now carries the
points that review asked of it: (b)'s and (c)'s gains, the trust cost of `management`, and "through extension
messaging".

---

## Appendix V. The review of v2: findings and what was done (record from v3)

No finding is rejected. "SDK" means `docs/sdk/SIXKEY-PLUGIN-SDK.md` 1.0-draft.3.

| V    | Severity | Finding (short)                                                      | Disposition                                                                                                                                                                                                                                                                       |
| ---- | -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1  | High     | A release has two meanings and no binding                            | **Fixed.** One meaning: it authorises one `codes.arm` (a new `release` field), bound to the tab, the top-level origin and the account, 10 s. `retry` carries one. Mutants and conformance cases (§3.5, §5.3; SDK §6.3, §16.1)                                                     |
| V-2  | High     | `sites.propose` redirects codes                                      | **Fixed.** Official-only in version 1. Its change list shows the registrable domain in large type, with warnings (§5.1; SDK §6.2, §6.3)                                                                                                                                           |
| V-3  | High     | Plugins can make Sixkey's popup and PIN screen appear                | **Fixed.** Surfaces open only once within the interaction window, or for the official locked flow; otherwise only the badge. A 600 ms input delay, no default button, spacing including lock-screen openings (§5.8; SDK §6.4)                                                     |
| V-4  | Medium   | P0 account events leak a handle and a site match                     | **Fixed.** Account slots, handles and `thisSite` need P1. The schema forbids `account` and `release` in P0 events (§5.1; SDK §7.1, §7.4)                                                                                                                                          |
| V-5  | Medium   | The checks have no order, and the order leaks                        | **Fixed.** A normative order, plus a per-trust table: P0 never sees `locked`; P1 reads only with a surface open and gets `unavailable`, never `locked`; non-official P3 gets `waiting`, and the card comes before any match (§5.3; SDK §10.6)                                     |
| V-6  | High     | The descriptor's lifecycle is unspecified; unlisted plugins deadlock | **Fixed.** The last validated descriptor is stored in the grant store and drawn from. Any change to contributions or capabilities suspends the plugin. Listed contributions are pinned by `contributionsHash` in the catalog (SDK §4.2)                                           |
| V-7  | Medium   | `hello` cannot evolve                                                | **Fixed.** The descriptor is read tolerantly, unknown names go to `unavailable`, and negotiation reads `sdkVersion`/`sdkMin` first. Envelopes stay strict (SDK §2.3, §5.3)                                                                                                        |
| V-8  | Medium   | The grant MAC binds too little                                       | **Fixed.** One tagged record binds every plugin ID, the descriptors, `developerMode` and an `epoch`, with JCS serialisation. The trust level is never stored; rollback is checked within a session, and the residual is stated (§5.6; SDK §6.6)                                   |
| V-9  | Medium   | Drop versus answer; plugin-opened ports                              | **Fixed.** One table of who is dropped and who is answered; plugin-opened ports are disconnected and logged (SDK §5.4, §3.3)                                                                                                                                                      |
| V-10 | Medium   | Events to unlisted plugins                                           | **Fixed.** Delivered at the next surface port; unlisted plugins have no deferred requests (SDK §10.4)                                                                                                                                                                             |
| V-11 | Medium   | An embedded page fails the sender rule                               | **Moot**, because embedded pages are out of version 1. The rule is listed as a precondition for any later version (SDK §7.5)                                                                                                                                                      |
| V-12 | Medium   | Text-safety holes                                                    | **Fixed.** `keys` follows the shortcut grammar and is drawn as a key cap. `plainText` strips bidi marks and default-ignorables (astral ones in prose). Protected terms are whole words on the TR39 skeleton ("Pinterest" passes). PNG IHDR ≤ 64 × 64 (SDK §2.3, §5.1, §7.2, §7.3) |
| V-13 | Medium   | The `codes.forPage` card's contents                                  | **Fixed.** A MUST: the plugin, its badge, the host with the registrable domain emphasised, the account or the choice (SDK §6.4 item 5)                                                                                                                                            |
| V-14 | Medium   | Plugin-side MUSTs cannot be tested                                   | **Fixed.** Split into what Sixkey observes (conformance) and review-checklist or source-rule items (SDK §16.2)                                                                                                                                                                    |
| V-15 | Low      | `addResult.handles`; the duplicates oracle                           | **Fixed.** Added accounts only, in input order, `null` for the rest; the oracle is stated as a residual (SDK §6.3, §13)                                                                                                                                                           |
| V-16 | Low      | "Undetectable" is too broad                                          | **Fixed.** Qualified: through messaging only; `management` and `tabs` holders, and the settings-page opening, are exceptions (§5.2; SDK §1.1, §14)                                                                                                                                |
| V-17 | Low      | P1 wording undersells it                                             | **Fixed.** "Account names (often your email address)" (SDK Appendix B)                                                                                                                                                                                                            |
| V-18 | Medium   | A plugin's own popup while Sixkey's is open                          | **Kept open as probe M0-14**; the flows fall back to a window (§5.4, §11 item 30; SDK §12)                                                                                                                                                                                        |
| V-19 | Low/Nit  | `localeTag`, uniqueness, paths, the 2 s rule, licence, trash         | **Fixed.** `es_419` accepted; uniqueness by prose and conformance; paths normalised with `new URL()`; `codes.forPage` exempt from 2 s; licences settled by file 01; trash marks for plugin-trashed accounts (SDK §4.1, §9.7, §10.8, header)                                       |
| V-20 | High     | MQ1a states no cost for its own option                               | **Fixed.** Q-A lists the platform's costs, and what (d) gains (§12)                                                                                                                                                                                                               |
| V-21 | High     | Thirteen questions are too many                                      | **Fixed.** Q-A and Q-B with defaults; the rest are defaults or moved to files 01, 03, 06, 07 and 14 (§12.3)                                                                                                                                                                       |
| V-22 | High     | `ui.embed` is unsafe; `frame-src` gates nothing                      | **Fixed.** `ui.embed` and `sidepanel.tab` are dropped from version 1, with the preconditions for any later version (§5.5; SDK §7.5)                                                                                                                                               |
| V-23 | Medium   | "The popup answers" needs one responder                              | **Fixed.** The worker stays silent while a live, flagged surface answers; `undefined` means `unavailable`; two race tests (§5.4; SDK §3.3 item 6)                                                                                                                                 |
| V-24 | Medium   | A Sixkey-opened port dies 30 s after the last message                | **Fixed.** The port is opened by the surface and lives with it; no deferred requests for unlisted plugins; sleep tests use raw CDP (§5.2; SDK §3.3, §11.3)                                                                                                                        |
| V-25 | Medium   | Any extension can open Sixkey's settings page with a fragment        | **Fixed.** Fragments may navigate and pre-fill, never act; the user always confirms; possible detection kept open (§2.2; SDK §9.2, §14)                                                                                                                                           |

The probe results (§1.6) are folded into §1.2, §2.2, §3.2, §4.1, §4.2, §5.2, §5.4, §5.5, §7.1, §9 and §11, and into SDK
§1.2, §3.3, §7.5, §8.2, §9.2, §11.3 and §14.

---

## Appendix R. The review of v1: findings and what was done (record from v2)

"Fixed" means the finding was folded in at the place named in v2. No finding was rejected outright. Two were taken in a
stricter form, and one in part. Where v3 changed the fix again, the last column says so.

| R    | Severity | Finding (short)                                   | Disposition in v2                                                                                 | v3                                     |
| ---- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| R-1  | High     | An unpacked impostor replaces the real plugin     | **Fixed.** Re-verified (C9, C10); F4, §3.7, §8.3, §10, §11; SDK §8.2, §13                         | confirmed by PRB M0-8                  |
| R-2  | High     | `action.openPopup()` grants no `activeTab`        | **Fixed.** Re-verified (C8); F1, §0.4, §3.4, §5.4, §6, §9.1; the screenshot example and brokering | —                                      |
| R-3  | Medium   | `url` is site-locked                              | **Fixed.** §1.2, §3.2, §5.3; SDK §6.3                                                             | —                                      |
| R-4  | Medium   | The arm rule is too loose                         | **Fixed.** Worker-only arms with the declared `worker`                                            | `new URL()` normalisation added (V-19) |
| R-5  | Low      | The unscrubbed tab is an implementation detail    | **Fixed.** Fail closed, never `pendingUrl`, an e2e assertion                                      | —                                      |
| R-6  | Low      | Update §11 and M0                                 | **Fixed**                                                                                         | updated with PRB                       |
| R-7  | Medium   | "Chrome's page would show it" is probably false   | **Fixed**; probe B2                                                                               | confirmed by PRB B2                    |
| R-8  | High (B) | B breaks patches 2 and 3                          | **Fixed.** §7.2                                                                                   | —                                      |
| R-9  | Low      | Off leaves the site grants                        | **Fixed**                                                                                         | —                                      |
| R-10 | Nit      | Direct answers on B                               | **Fixed.** §9.3                                                                                   | PRB B2 added                           |
| R-11 | High     | The study does not steelman the owner             | **Fixed.** v2 starts from the platform; data packs                                                | —                                      |
| R-12 | High     | A C-shaped first official plugin                  | **Fixed.** Option C                                                                               | in Q-A (b)                             |
| R-13 | Medium   | A built-in official plugin                        | **Fixed.** Option I, recommended                                                                  | Q-A (a)                                |
| R-14 | High     | Costs in the wrong unit                           | **Fixed.** Agent-days and rounds                                                                  | —                                      |
| R-15 | High     | O2 rests on the plugin's arming rule              | **Fixed.** The invariant; OQ2 (c) gives up C-d                                                    | review checklist item (V-14)           |
| R-16 | Medium   | O3 checks the tab, not the user                   | **Fixed.** O4, the icon mark, lower limits                                                        | —                                      |
| R-17 | Medium   | A malicious official update                       | **Fixed.** §3.7; the publisher account                                                            | the account moved to file 07           |
| R-18 | Medium   | The plugin's own storage                          | **Fixed.** The storage invariant                                                                  | PRB M0-8 noted                         |
| R-19 | Medium   | Clickjacking of the plugin's UI                   | **Fixed**                                                                                         | no frames at all in v1                 |
| R-20 | Medium   | "Lock every time" without a code-carrying message | **Fixed.** The popup answers                                                                      | the single-responder rule (V-23)       |
| R-21 | Medium   | `codeSender` for http, IP addresses and ports     | **Fixed.** Its mutants                                                                            | —                                      |
| R-22 | Medium   | The `sites` hand-over                             | **Fixed.** Deleted                                                                                | —                                      |
| R-23 | Low      | A disabled plugin; the impostor replaces          | **Fixed**                                                                                         | PRB M0-9 (b)                           |
| R-24 | High     | Tiers limit only what Sixkey hands over           | **Fixed.** API scopes                                                                             | —                                      |
| R-25 | High     | A tier map                                        | **Fixed, in part.** Not taken: commands and settings forms in P0                                  | account slots moved to P1 (V-4)        |
| R-26 | High     | The VS Code analogy                               | **Fixed**                                                                                         | —                                      |
| R-27 | High     | Official versus third party without `management`  | **Fixed.** Optional `management`                                                                  | in Q-B                                 |
| R-28 | High     | Runtime approval against detectability            | **Fixed.** Static `ids` and ports                                                                 | ports from surfaces (V-24); PRB M0-9   |
| R-29 | High     | Malicious third-party updates                     | **Fixed**                                                                                         | pinned contributions (V-6)             |
| R-30 | High     | Declarative slots over iframes                    | **Fixed, stricter**                                                                               | iframes dropped entirely (V-22)        |
| R-31 | Medium   | Approvals are security state                      | **Fixed.** A MAC                                                                                  | binds plugin IDs and an epoch (V-8)    |
| R-32 | Medium   | Limited Use                                       | **Fixed**                                                                                         | wording moved to file 06 / OQ3         |
| R-33 | Medium   | A developer switch in the store build             | **Fixed.** An option                                                                              | in Q-B (S-5)                           |
| R-34 | High     | MQ1 unbalanced                                    | **Fixed.** MQ1a and MQ1b                                                                          | merged into Q-A with costs (V-20)      |
| R-35 | Medium   | MQ2                                               | **Fixed**                                                                                         | inside Q-A                             |
| R-36 | High     | MQ3 around the tiers                              | **Fixed**                                                                                         | inside Q-B, neutral                    |
| R-37 | Medium   | MQ4                                               | **Fixed**                                                                                         | inside Q-B (S-5)                       |
| R-38 | Low      | MQ5 with OQ2                                      | **Fixed**                                                                                         | file 14 OQ2 only                       |
| R-39 | Low      | MQ6                                               | **Fixed**                                                                                         | files 07 and 03                        |
| R-40 | High     | Missing questions                                 | **Fixed.** MQ7–MQ12                                                                               | defaults or presets (V-21)             |


## 2026-11-02: official encrypted cloud transport

The owner requested “把云备份功能做成官方插件吧”. Cloud Backup is now a separately packaged official extension. The
core initiates an ID-pinned transport protocol; it exposes no backup-fetch SDK request. The new official-only,
sensitive `backups.transport` grant permits only already encrypted files, after backup is separately enabled. The
Never list continues to forbid plaintext exports, credentials, decryption keys and backups containing plaintext.
See `extension/plugins/official/cloud-backup/README.md` and ARCHITECTURE's provider section for the exact boundary,
and `docs/design/notes/CLOUD-PLUGIN-NOTES.md` for its review and follow-up (the plugin built for fixed Sixkey IDs, the
approval made in the backup's one click).
