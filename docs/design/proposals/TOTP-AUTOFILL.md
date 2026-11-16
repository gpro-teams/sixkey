# TOTP autofill: design proposal (TOTP-AUTOFILL)

> **Stage 1 implemented (2026-10-21).** The minimal-risk subset of §12.2 (gesture fill: the finder, the popup and side panel
> Fill button, the `fill` shortcut, matching M1 to M5, the time window, no host permission, no registered script, no
> network) is in `extension/`; what was built, where it deviates from this document and why, and what Stage 2 will add are in
> [`docs/design/notes/AUTOFILL1-NOTES.md`](../notes/AUTOFILL1-NOTES.md). `docs/PRIVACY.md` and `docs/ARCHITECTURE.md` §4 were
> rewritten as §12.4 lists for Stage 1 only. **Stages 2 and 3 (per-site automatic suggestions, the rule corpus and its updates)
> are not implemented**, and the text below that is about them is still a proposal. The preparation of §4.2 is in
> [`AUTOFILL-PRE-NOTES.md`](../notes/AUTOFILL-PRE-NOTES.md).

> **Proposal: not approved as a whole, and not implemented.** Nothing in `extension/`, `api/` or `contract/` changes
> because of this document. The owner has already answered five questions (§0.2): the rule corpus licence, no account
> for rule updates, the rules endpoint as an optional permission, one release train, and the feature being optional
> with a kill criterion. Everything else is a proposal. `docs/PRIVACY.md`, `docs/ARCHITECTURE.md` §4 and
> `extension/scripts/check-dist.mjs` would change if it is approved; §12.4 lists exactly what changes, and none of it is
> edited here. It has not been reviewed independently.

Date: 2026-10-20. Author: design proposal (Opus 5.5) at the owner's request.

**Markers**, as in the other proposals:

- **[verified]**: I read the primary source. That means this repository's code, an official Chrome or Chrome Web Store
  document, a specification, or a licence file.
- **[transcribed]**: taken from a secondary write-up, a mirror, or a vendor page I fetched but did not test. Vendor
  claims stay vendor claims.
- **[inferred]**: my own reasoning.
- **[estimate]**: a number nobody measured.
- **[unverified]**: a claim I could not check. Every [unverified] claim is collected in §13, and most of them are Stage 0
  probes (§12.1).

---

## 0. Summary and recommendation (read this first)

### 0.1 What the owner asked (translated)

1. "Collect as many web TOTP entry points (the pages and fields where a 6-digit code is typed) as possible, and show an
   autofill at the right moment, automatically."
2. Follow-up: "Autofill is a cloud feature. We can sync the autofill rules **and logic** (how input fields are found) in
   real time, so we don't keep the maintenance in the code, avoid open-sourcing it, and protect our moat."
3. Follow-up, revising item 2: "It is open source. Anyone who takes the rules must comply with the AGPL-3.0 licence."

### 0.2 Owner decisions already made (2026-10-20)

| #   | Question                                        | Owner's answer                                                                                                                                                  | Where it is applied |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| D1  | Licence of the rule corpus                      | **Open, AGPL-3.0-or-later** (the server's licence). The engine stays in the MPL-2.0 extension.                                                                  | §6.5, §6.6          |
| D2  | Do live rule updates need a cloud account?      | **No.** A signed static bundle, with no identity attached.                                                                                                      | §7.4                |
| D3  | Host permission for the rules endpoint          | **Acceptable as an optional permission.** Behind an opt-in toggle that is off by default. With the toggle off, the extension uses the baseline bundled with it. | §7.3                |
| D4  | Ship Stage 2 automatic suggestions?             | **Yes, all together.** Stages 1–3 are one release train, released together, not piecemeal.                                                                      | §12                 |
| D5  | Is the feature essential?                       | **No, nice to have.** If the store-review risk is significant, cut it. A kill criterion and a minimal-risk subset are required.                                 | §0.6, §12.3         |
| D6  | Should the rule logic be closed and cloud-only? | **Withdrawn by D1.** The rules are open data. What runs in the browser is open source.                                                                          | §7                  |

### 0.3 Corrections to the brief, from the code

1. **The per-account sites field already exists.** `Entry.domains` (`core/vault/model.ts`) is in the content register
   (`merge.ts` `contentOf`). `validate.ts` checks it at 16 domains or fewer, each of 253 characters or fewer
   (`LIMITS.domains`, `LIMITS.domain`). The selected-accounts backup (`backup/subset.ts`) and import dedupe
   (`import/dedupe.ts`) both carry it. SYNC-DESIGN already says "Remember this site" writes it as an ordinary synced
   edit [verified].
   - **Before sync ships, autofill needs no new vault field, record, vector or contract change.** §0.7 has the exact list.
2. **The public suffix list was rejected on purpose.** `core/site-domains.ts` rejects it (335 KB, changes weekly) and
   keeps a small table of shared suffixes instead [verified]. `core/match.ts` already has the matching this feature
   needs: an exact or label-boundary suffix match on registered domains only, in punycode, with IP hosts matched exactly.
   The name guess is labelled "Possibly related" and is never shown as "This site" [verified].
   - Autofill builds on this. Only the `registered` tier ever fills.
3. **Executable logic cannot be updated remotely.** That is Chrome Web Store policy. The rules can be updated remotely
   as data (§7.1).
4. **There are already two promises in text that the feature would make false**: `docs/PRIVACY.md` says "No content
   scripts: it never runs code in, or changes, the web pages you visit", and `docs/ARCHITECTURE.md` §4 says "There are
   no content scripts and nothing is exposed to pages" [verified]. **Stage 1 already breaks both.** A Fill click runs
   `executeScript`, which injects a one-shot content script and changes the page's field. Stage 2 goes further, with a
   persistent script on the sites the user granted. Both sentences must be rewritten, not just extended (§12.4).

### 0.4 Recommendation in one table

| Area                    | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission model**    | **(a) + (b).** (a) is the floor: `activeTab` with a user gesture (toolbar popup, or a new "Fill code" shortcut), plus the `scripting` permission. Neither shows an install warning [verified]. (b) is the automatic part: an **optional host permission requested one site at a time**, in the click where the user turns on suggestions for that site, plus a content script registered for granted origins only. (c), an all-sites toggle, is deferred to after the train and needs a separate owner decision (Q1). (d), a required broad permission, is rejected. |
| **Where consent lives** | In a surface the page cannot touch: the popup, the keyboard command, the toolbar icon or badge. The Stage 2 in-page suggestion is an addition, hardened against DOM clickjacking (§4.5). A code never goes into a page without a trusted user action, and never without a domain match.                                                                                                                                                                                                                                                                              |
| **Detection**           | One small dependency-free engine, the same in both paths. It scores fields (`autocomplete="one-time-code"`, numeric hints, length, label words in 11 languages, segmented boxes) with negative signals for search, phone, card and CAPTCHA fields. A site rule (data) can override it (§3).                                                                                                                                                                                                                                                                          |
| **Fill path**           | The extension context computes the code (the popup, or the service worker when it holds the vault key). It passes **only the current code** to one injected call, pinned by `documentId` to the document that was inspected. That call checks its own origin again before writing. Content scripts never hold a secret and cannot ask for a code (§4).                                                                                                                                                                                                               |
| **Matching**            | `match.ts` `registered` tier only. "Possibly related" accounts are offered in the popup with "Remember this site", showing the exact host. Alias domains come from Apple's MIT list and only ever suggest, never fill (§5).                                                                                                                                                                                                                                                                                                                                          |
| **Data**                | A versioned JSON corpus under `rules/`, AGPL-3.0-or-later (D1). It has a JSON Schema, synthetic HTML fixtures, and CI that runs every rule in Playwright. The baseline ships inside each release. 2fa.directory (MIT) and Apple password-manager-resources (MIT) are the inbound sources (§6).                                                                                                                                                                                                                                                                       |
| **Live updates**        | One signed static file, the same for everyone, fetched by the service worker about once a day. It needs no account (D2) and sits behind an opt-in toggle with an optional host permission (D3). It is data, never code, and is checked against the same closed schema as the baseline (§7).                                                                                                                                                                                                                                                                          |
| **Timing**              | Triggers are a trusted interaction with a candidate field, a high-confidence 2FA page, or a click in the popup. At most one suggestion per document. Fill only if at least 5 s of the code's window remain, otherwise fill the next code. No clipboard, no auto-submit (§8).                                                                                                                                                                                                                                                                                         |

### 0.5 Why this model, in three sentences

The only part of the request that conflicts with Sixkey's promises is "automatically, everywhere". That needs a content
script on every page and the "Read and change all your data on all websites" warning, and Chrome Web Store reviews such
requests longer [verified]. Per-site opt-in gives the automatic behaviour on exactly the sites the user chose. It adds no
install warning, keeps the content script off every other site, and so takes away a hostile page's chance to probe which
accounts the user has (§9). The gesture path covers every other site with no permission at all.

### 0.6 Kill criterion and the minimal-risk subset (D5)

What carries store-review or permission risk, and what does not:

| Part                                                              | New permission or manifest change                                        | Install warning                               | Store-review risk                                                                                                                         | Promise text affected                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Gesture fill (popup button, shortcut), heuristics, matching       | `scripting` (required); one new command                                  | none [verified]                               | **low** [inferred]: a no-warning permission with an obvious use                                                                           | two sentences rewritten: PRIVACY.md "No content scripts", ARCHITECTURE §4 |
| Bundled rule baseline (data in the package)                       | none                                                                     | none                                          | **none** [inferred]: packaged data is not remote code                                                                                     | none                                                                      |
| Toolbar hint via `declarativeContent` (optional extra of Stage 1) | `declarativeContent`                                                     | none [verified]                               | low                                                                                                                                       | none                                                                      |
| Per-site automatic suggestion                                     | `optional_host_permissions: ["https://*/*"]`, registered content scripts | none at install; a per-site prompt at runtime | **real**: broad host patterns lengthen review [verified]. Whether an **optional** pattern alone sets off in-depth review is [unverified]. | PRIVACY.md "No content scripts", ARCHITECTURE §4                          |
| Live rule updates                                                 | a second optional host origin; CSP `connect-src` gains it                | none at install                               | **moderate**: reviewers check remotely fetched data does not drive logic [inferred from the policy text, §7.1]                            | PRIVACY.md network paragraph                                              |
| All-sites mode (deferred, Q1)                                     | none beyond the per-site row; the user grants `https://*/*`              | Chrome's broad prompt at runtime              | high                                                                                                                                      | all of the above                                                          |

**Kill criterion** (K1–K4 can each cut a part; any one of them cuts it):

- **K1, store review.** Before the train is submitted, upload the Stage 2 + 3 package as a draft of the real item without
  submitting it. If the dashboard shows the in-depth-review notice [unverified that a draft upload shows it], or if one
  submission is rejected or warned for permissions, or if review takes more than 14 days: **ship the minimal-risk subset**
  and drop per-site suggestions and live updates from this release.
- **K2, page isolation.** If Stage 0 shows that `chrome.storage.local` cannot be closed to content scripts on Chrome 120
  (the manifest minimum), there are **no content scripts**, so Stage 2 is cut (§4.2). Moving the minimum version up is the
  alternative.
- **K3, clickjacking.** If the in-page suggestion cannot pass the DOM clickjacking test set (§11.3), Stage 2 ships with
  the badge and shortcut only, without in-page UI.
- **K4, remote-data review.** If a reviewer treats the rule bundle as an interpreter, live updates are cut and the
  baseline ships with each release only.

**Minimal-risk subset, the thing to ship first if any of K1–K4 fires:** Stage 1 (gesture fill with heuristics and
matching), plus the Stage 3 corpus **bundled only**. It brings **no registered or persistent content scripts**, only
one-shot injections on the user's click. It brings no host permissions and no network use. It needs `scripting` and one
shortcut. It keeps every promise except the two "no content scripts" sentences, which are rewritten to "code runs in a
page only when you click Fill" (§12.4).

### 0.7 What must be done before sync ships, and before the first store release

**Format changes needed: none.** Autofill uses the existing `domains` field. The server and contract never see entry
fields, because the vault is an opaque envelope to them (`api/openapi.yaml`; the vectors hold only envelope plaintext
examples, without `domains`) [verified]. Three decisions should be recorded in SYNC-DESIGN §3.13 when it is next revised
(this document does not edit it):

1. **Autofill state is device-local and not synced.** That covers per-site enablement (Chrome's per-profile grants), the
   per-document "not now", the all-sites never-list if Q1 is approved, and the rule bundle. The reason: a host permission
   is granted per browser profile and cannot travel in the vault.
2. **No per-account autofill flag in schema 1.** I11 (any new entry field raises `schemaVersion`) makes a later field
   expensive [verified]. If the owner wants "never autofill this account", add it in **the same schemaVersion 3
   revision** as the tiers proposal (`ADVANCED-RECOVERY-AND-TIERS.md` §2.4), its only cheap window. A protected (tier-2)
   account already never fills without a step-up (§10), so no flag is needed for that.
3. **`domains` semantics are frozen as host names**, matched as today (`match.ts`), and remain the only input that ties
   an account to a site. Rules never add domains to accounts (§5.1 invariant M1).

The extension is not in the store yet. Until its first store release, even a schema 1 change would cost nothing, but none
is needed.

### 0.8 Remaining owner questions

Only these remain for the owner. Each has a recommendation, and §14 gives the detail.

1. **Q1. All-sites mode (Stage 4).** Should Sixkey ever offer the optional "on all sites" grant, with its broad Chrome
   prompt? _Recommendation: not in this train. Decide after Stage 2 has been in use. It conflicts with "minimal
   permissions" in spirit even as an option._
2. **Q2. Store-facing wording.** Approve the permission-prompt texts (§2.6), the rule-update toggle text (§7.3), and the
   two PRIVACY.md and store-listing sentences that change (§12.4), in English and Chinese. Store copy is already an owner
   item (OWNER-DECISIONS 06).
3. **Q3. Third-party data and attribution.** Accept the 2fa.directory attribution shown in the product ("Data sourced from
   2FA Directory by 2factorauth"). Accept that Bitwarden's AGPL equivalent-domains list is **not** imported in this train
   (§6.6). _Recommendation: yes to both._
4. **Q4. Kill criterion K1.** Is 14 days the right review-time threshold, and do you accept K1 as stated? _Recommendation:
   yes._

---

## 1. Facts that decide the design

### 1.1 Chrome platform [verified unless marked]

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `activeTab` is granted by an action click, a context-menu item, a `commands` shortcut, or an omnibox suggestion. It lasts while the user stays on that page, survives same-origin navigation, and ends on a cross-site navigation or when the tab closes. It "displays no warning message during installation".                                                                                                                                                                                                    | Chrome docs, activeTab                                  |
| `executeScript` and `insertCSS` need the `scripting` permission. The permissions list shows no warning for `scripting`, `activeTab`, `declarativeContent`, `offscreen`, `storage`, `alarms` or `idle`. `tabs` and `webNavigation` warn "Read your browsing history".                                                                                                                                                                                                                                               | Chrome docs, activeTab; permissions list                |
| Whether `activeTab` covers **cross-origin iframes** in Chrome is not documented. Firefox bug 1839200 says it does not there, and cites Chromium issue 826433. **[unverified for Chrome]**                                                                                                                                                                                                                                                                                                                          | Chrome docs (silent); Bugzilla                          |
| `permissions.request` must run inside a user gesture. To request hosts found at runtime, include `"https://*/*"` in `optional_host_permissions`. An update that adds only optional permissions does not disable the extension. Whether optional host patterns appear in the install prompt is not stated; my reading is that they do not **[unverified]**.                                                                                                                                                         | Chrome docs, permissions API                            |
| `permissions.addHostAccessRequest` (Chrome 133+) shows a request "only … if extension can be granted access", on a tab or a top-level document. "When accepted, grants persistent access to the site's top origin." Our manifest minimum is Chrome 120.                                                                                                                                                                                                                                                            | Chrome docs, permissions API                            |
| `scripting.registerContentScripts` (Chrome 96+): `allFrames`; `matchOriginAsFallback` (119+); `persistAcrossSessions` (default true); `runAt` (default `document_idle`); `world` (102+, default ISOLATED). `executeScript`: `func` plus JSON-serializable `args`; `documentIds` (106+), which cannot be combined with `frameIds`.                                                                                                                                                                                  | Chrome docs, scripting API                              |
| An isolated world "isn't accessible to the page or other extensions". Page and content script share only the DOM.                                                                                                                                                                                                                                                                                                                                                                                                  | Chrome docs, content scripts                            |
| **`storage.local` and `storage.sync` are exposed to content scripts by default. `storage.session` is not.** Each area has `setAccessLevel` (`TRUSTED_CONTEXTS` / `TRUSTED_AND_UNTRUSTED_CONTEXTS`; the `AccessLevel` type is Chrome 102+). Whether `local.setAccessLevel` works on Chrome 120, and whether the setting persists before the worker runs, **[unverified]**.                                                                                                                                          | Chrome docs, storage API                                |
| `MessageSender` carries `id`, `url`, `origin` (80+), `tab` (present for content scripts), `frameId`, `documentId` (106+), `documentLifecycle`.                                                                                                                                                                                                                                                                                                                                                                     | Chrome docs, runtime API                                |
| "Assume that messages from a content script might have been crafted by an attacker". A content script can be taken over "if a malicious web page compromises the renderer process". "Limit the scope of privileged actions that can be triggered by content scripts."                                                                                                                                                                                                                                              | Chrome docs, Stay secure                                |
| `declarativeContent`: CSS conditions must be compound selectors (no combinators). They match only displayed elements in frames with the main frame's origin, need no host permission or content script, and rules persist across sessions. Actions are `setIcon` and `showAction`. `RequestContentScript` "is not supported on stable builds".                                                                                                                                                                     | Chrome docs, declarativeContent                         |
| `action.openPopup()` works for all extensions from Chrome 127 (118–126: policy-installed only). Whether it needs a gesture is not stated **[unverified]**. `setBadgeText` and `setIcon` take a `tabId` and reset when the tab closes.                                                                                                                                                                                                                                                                              | Chrome docs, action API                                 |
| Extension service workers do not support dynamic `import()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Chrome docs, service worker basics                      |
| Users can set each extension's site access to "On click", "On specific sites" or "On all sites", and can add or remove allowed sites.                                                                                                                                                                                                                                                                                                                                                                              | Chrome Web Store help                                   |
| Store review: "Reviews may take longer for extensions that request broad host permissions or sensitive execution permissions". Most reviews take "a few days, but it can take up to a few weeks". The policy says to request "the narrowest permissions necessary" and not to "future proof" by requesting a permission.                                                                                                                                                                                           | CWS review process; CWS permissions policy              |
| Single purpose: "An extension must have a single purpose that is narrow and easy to understand."                                                                                                                                                                                                                                                                                                                                                                                                                   | CWS quality guidelines                                  |
| Remote code: "the full functionality of an extension must be easily discernible from its submitted code"; external resources "must not contain any logic"; a remote configuration file "for A/B testing or determining enabled features" is allowed if "all logic … is contained within the extension package"; "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data" is a violation. RHC "does not include data or things like JSON or CSS". | CWS MV3 requirements; Chrome docs, remotely hosted code |
| HTML autofill: `one-time-code` is "One-time code used for verifying user identity", in the Password control group (text, search, password inputs). Example "123456".                                                                                                                                                                                                                                                                                                                                               | WHATWG HTML                                             |
| Firefox: from Firefox 127, `host_permissions` are shown at install and granted. `optional_host_permissions` exist, and users can revoke host access ad hoc. MV3 content scripts follow the extension CSP.                                                                                                                                                                                                                                                                                                          | Firefox Extension Workshop                              |

**Firefox, Edge and Brave (note only).** Edge and Brave run Chromium's extension system and the Chrome Web Store package,
so everything above applies [inferred]. Edge has its own store review [unverified]. Firefox has no `documentIds`
targeting in the same form, and `match_origin_as_fallback` is not documented there [unverified]. A Firefox port is out
of scope.

### 1.2 This repository [verified]

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Permissions are exactly `storage, unlimitedStorage, activeTab, alarms, idle, offscreen`. The optional permissions are `clipboardRead` and `clipboardWrite`. The only optional host permission is the API origin. Manifest keys and commands are pinned, and `content_scripts`, `web_accessible_resources` and `externally_connectable` fail the build.                                                                              | `manifest.base.json`; `scripts/check-dist.mjs`           |
| The manifest CSP is `connect-src https://api.sixkey.app` (no `'self'`), and every page adds `connect-src 'none'`. `fetch` may appear only once, in the worker's transport.                                                                                                                                                                                                                                                          | `check-dist.mjs`; `platform/fetch-transport.ts`          |
| Popup budget 60 KB gzip: **58.2 KB used** (static 54.2 + zh_CN catalog 4.1). Full catalogs: en 10.5, **zh_CN 11.9 of 12 KB**. Sync catalogs have their own 12 KB budget.                                                                                                                                                                                                                                                            | `check-dist.mjs` output, prod build of this tree         |
| _(This describes the code before AUTOFILL-PRE, which has since added the sender checks of §4.2 item 1; see `docs/design/notes/AUTOFILL-PRE-NOTES.md`.)_ The service worker's first `onMessage` listener checked only `sender.id === chrome.runtime.id`. The offscreen document's listener checked **no sender at all**. A content script has the extension's own ID, and its `runtime.sendMessage` reaches every extension context. | `background/sw.ts:116–135`; `offscreen/main.ts:38`       |
| `chrome.storage.local` holds the encrypted vault slots, snapshots, the keyring (`sk_keyring`), `sk_pin`, settings and the security record.                                                                                                                                                                                                                                                                                          | `docs/ARCHITECTURE.md` §3                                |
| The unlocked vault key lives in `storage.session` (standard mode), or only in the unlocking page ("lock every time"). The PIN session parks it under the PIN in `sk_quick`.                                                                                                                                                                                                                                                         | `docs/ARCHITECTURE.md` §2.3, §3; QUICK-UNLOCK §5.2       |
| The popup already reads the active tab's URL through `activeTab` and puts registered-site accounts first.                                                                                                                                                                                                                                                                                                                           | `popup/main/Main.tsx`                                    |
| The extension is MPL-2.0 with no "Incompatible With Secondary Licenses" notice. `LICENSES/AGPL-3.0-or-later.txt` exists. `REUSE.toml` is the only licence map, and no file carries a header. Contributions are under the licence of the files they change, with DCO 1.1 and no CLA.                                                                                                                                                 | `LICENSE.md`; `REUSE.toml`; `CONTRIBUTING.md`; `DCO.txt` |

---

## 2. Permission model

### 2.1 The options

| Option                                               | What the user sees at install                                 | Automatic?                     | Code in pages                                   | Fits the promises?                                                                                         | Verdict            |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| **(a)** `activeTab` + `scripting` + gesture          | nothing new [verified]                                        | no: popup, shortcut            | one call, only when the user asks               | yes                                                                                                        | **floor, Stage 1** |
| **(b)** optional host permission per site, at opt-in | nothing new [unverified, see §1.1]                            | yes, on sites the user enabled | a small content script, on granted origins only | yes, with two text changes; the store-review risk is K1                                                    | **Stage 2**        |
| **(c)** optional all-sites toggle                    | nothing at install; broad prompt on toggle                    | yes, everywhere                | everywhere                                      | weak: "minimal permissions" holds only on paper; every page becomes an attack surface; review risk is high | **deferred (Q1)**  |
| **(d)** required `<all_urls>` / `*://*/*`            | "Read and change all your data on all websites" [transcribed] | yes                            | everywhere, from install                        | **no**                                                                                                     | **rejected**       |

**`webNavigation`** would let the worker see the password-submit navigation, but it warns "Read your browsing history" and
reports every navigation. Rejected [verified warning]. **`tabs`** has the same warning and is not needed, because the
`activeTab` and `sender.tab` URL are enough [verified]. **`declarativeContent`** is useful (§2.4).

### 2.2 MV3 constraints that shape the design [verified unless marked]

- **Service worker.** The worker can be stopped at any time and keeps no state (ARCHITECTURE §2.2). Every decision that
  must outlive an event (granted sites, the rule store) lives in Chrome's permission store or in extension storage.
- **No remote code.** All detection and fill logic ships in the package. Rules are data (§7.1).
- **CSP.** Content scripts follow the extension CSP (Firefox docs say so for MV3; Chrome's isolated-world CSP is the
  extension's [unverified for Chrome detail]). The engine uses no `eval`, no `new Function`, and no inline handlers.
- **No dynamic `import()` in the worker.** Rule lookups cannot load code shards. They read data (§6.4).

### 2.3 Recommended model and progressive path

1. **Always available (Stage 1):** the popup's **Fill** button on the matched account, and a new command **Fill code**
   (suggested key Alt+Shift+F [unverified for conflicts]). Both grant `activeTab`. No content script is installed.
2. **Per site (Stage 2):** after a successful gesture fill on a site with a registered account, the popup offers once:
   "Suggest codes automatically on github.com?" A **Turn on** click requests the origin `https://github.com/*` with
   `permissions.request` inside that click [verified gesture rule]. When the grant succeeds, the worker adds the host to
   an explicit stored list of autofill sites, and updates **one** registered content script.
   - The script's `matches` are that list **intersected with** the current grants. The API origin and the rules origin
     are always excluded.
   - A permission alone never turns autofill on. Network consent (sync, rule updates) and autofill consent stay
     separate: the same "setting plus permission" rule as §7.3.
   - The same switch exists per site in Settings › Autofill, and from the toolbar menu.
   - "Turn off for this site" calls `permissions.remove` and re-registers the script. Chrome's own site-access controls
     do the same from outside; the worker listens to `permissions.onRemoved` and re-registers [verified events].
3. **Chrome 133+ refinement:** `permissions.addHostAccessRequest({tabId, pattern})` can put the request in Chrome's
   extensions menu instead of the popup, with no gesture and no dialog of ours [verified API; unverified UI]. Feature-
   detect it, because the minimum is Chrome 120.
4. **Stage 4 (only if Q1 is yes):** an "On all sites" switch that requests `https://*/*`. Same engine, same rules.

Granted origins are exact hosts (`https://github.com/*` does not cover `gist.github.com`) [inferred from match-pattern
semantics]. That is the narrow scope we want for automatic suggestions (§5.1 M6).

### 2.4 Toolbar hint without any host access (Stage 1 extra)

`declarativeContent` can change the toolbar icon on pages that show a one-time-code box, with no host permission and
without the extension learning the URL [verified capability]. Rules use only generic compound selectors, for example
`input[autocomplete="one-time-code"]` and `input[inputmode="numeric"][maxlength="6"]`. **Never put registered domains
into `pageUrl` conditions.** Chrome stores rules in plaintext in the profile [verified "persist"; plaintext inferred],
and the domains are otherwise protected inside the encrypted vault. Cost: a few dozen selectors [inferred: Chrome warns
only about hundreds]. This is optional. Cut it if it adds review questions.

### 2.5 What Chrome stores in plaintext

Granted host permissions and registered content scripts are kept by Chrome in the profile [inferred: they persist across
restarts, so they are on disk]. Anyone with a copy of the profile (attacker A3 in SYNC-DESIGN §1.2) can read **which
sites have automatic suggestions**: a subset of the sites where the user has 2FA. The vault keeps its account list
encrypted, but this list is not. Say so in PRIVACY.md and next to the per-site switch. All-sites mode would reveal no
per-site list, an irony worth recording, but it is not a reason to prefer it.

### 2.6 The prompt, its wording, and Chrome's dialog

Shown in the popup after a successful fill, once per site. "Not now" hides it on that site until the browser restarts
(held in `storage.session`, §8.3).

| Element     | English                                                                                                                                                                                                                   | 简体中文                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title       | Suggest codes automatically on github.com?                                                                                                                                                                                | 在 github.com 上自动提示验证码？                                                                                                                                          |
| Body        | When this site asks for a verification code, Sixkey offers yours next to the box. It looks only for that box, and it sends nothing anywhere. Chrome will ask you to let Sixkey "read and change your data on github.com". | 当此网站要求输入验证码时，Sixkey 会在输入框旁提示你的验证码。它只查找这个输入框，不向任何地方发送数据。Chrome 会询问是否允许 Sixkey"读取和更改您在 github.com 上的数据"。 |
| Small print | You can turn this off for this site at any time, here or in Settings › Autofill. Chrome keeps the list of sites you turn on in its own settings.                                                                          | 你可以随时在这里或"设置 › 自动填写"中为此网站关闭。你开启的网站列表会保存在 Chrome 自己的设置中。                                                                         |
| Buttons     | **Turn on for github.com** · Not now                                                                                                                                                                                      | **在 github.com 上开启** · 暂不                                                                                                                                           |

Chrome's dialog text and its Chinese translation are Chrome's, not ours **[unverified exact wording; probe P5]**. The
quoted text in our body must be updated to match it.

**Stage 4 toggle, a draft so Q1 can be judged** (Settings › Autofill, off by default; not part of this train):

| Element | English                                                                                                                                                                                                                                                                                                                                                                                                     | 简体中文                                                                                                                                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label   | Suggest codes on every site                                                                                                                                                                                                                                                                                                                                                                                 | 在所有网站上提示验证码                                                                                                                                                                                                                                                  |
| Help    | Sixkey's small script will run on every page you open, to look for a verification-code box. It offers a code only where you registered the site for an account. It reads nothing else, stores nothing and sends nothing. Chrome will ask you to let Sixkey "read and change all your data on all websites": that is the widest permission an extension can have. Most people only need the per-site switch. | Sixkey 的小脚本会在你打开的每个页面上运行，查找验证码输入框；只在你为账户登记过的网站上提示验证码。它不读取其他内容，不保存也不发送任何数据。Chrome 会询问是否允许 Sixkey"读取和更改您在所有网站上的所有数据"：这是扩展程序能获得的最大权限。大多数人只需要按网站开启。 |
| Button  | **Allow on all sites** · Keep per site                                                                                                                                                                                                                                                                                                                                                                      | **在所有网站上允许** · 保持按网站开启                                                                                                                                                                                                                                   |

### 2.7 What each permission is used for

- **The purpose.** Autofill serves the same purpose as the code list, so it is not a second function [inferred].
- **`scripting`:** only when the user clicks Fill in the popup or presses the Fill shortcut. A small script of Sixkey's
  own runs in the current tab, finds the verification-code box and types the current code into it, with activeTab or on
  a site the user turned on.
- **`declarativeContent`** (if kept): the toolbar icon changes on pages that show a one-time-code box; the page is not
  read.
- **Optional host permission `https://*/*`:** requested one site at a time, only when the user turns on automatic code
  suggestions for that site, so that a small content script can notice the code box and offer the code. It is removed
  when the user turns the site off.
- **Optional host permission for the rules origin:** requested only when the user turns on rule updates, to download a
  signed JSON file of site rules. The file holds no logic and is checked against a fixed schema.
- **No remote code:** all logic is in the package; the optional rules file is data.
- **No user data is collected.** The page's URL and fields are processed locally and never stored or sent [inferred:
  as docs/PRIVACY.md says].

---

## 3. Detection

### 3.1 Signals and confidence score

A field qualifies only if it is an `input` of type `text`, `tel`, `number`, `password` or no type, or a
`contenteditable` cell inside a segmented group. It must be visible (non-zero box, not `visibility: hidden`), enabled,
and not read-only. Scores are added up [estimate weights, tuned on the fixture corpus]:

| Signal                                                                                                                                                                                           | Weight             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Site rule matches this page and field (§6.2)                                                                                                                                                     | +100               |
| `autocomplete="one-time-code"`                                                                                                                                                                   | +50                |
| `name`, `id`, `class` or `data-*` token: `otp`, `totp`, `2fa`, `mfa`, `tfa`, `one-time`, `onetime`, `passcode`, `verification`, `verify`, `authcode`, `token`, `code` (alone, weak: +10)         | +25                |
| Label, `aria-label`, `aria-labelledby`, placeholder or nearby heading contains a keyword from §3.2                                                                                               | +25                |
| `maxlength` 6–8, or a segmented group of 6–8 one-character boxes                                                                                                                                 | +15                |
| `inputmode="numeric"`, `pattern` of digits, or `type="tel"` / `type="number"` with the length above                                                                                              | +10                |
| URL path token: `2fa`, `mfa`, `otp`, `totp`, `verify`, `challenge`, `two-factor`, `second-factor`                                                                                                | +10                |
| Only one candidate on the page, and the page has no visible password field                                                                                                                       | +5                 |
| Negative: `type` is `search`, `email`, `url`; or a token for search, query, phone, `tel` (as a name), mobile, zip, postal, card, `cc-`, CVV/CVC, amount, price, quantity, coupon, promo, CAPTCHA | −60                |
| Soft negative: the label says the code was sent by **SMS, text message, email or phone call** (§3.2 second column)                                                                               | −20, kind = `sent` |

**Thresholds.** An automatic in-page suggestion needs 60 or more (Stage 2). The popup's Fill button needs 40 or more. Below
40, the popup offers "Fill into the box that has focus", only if the focused element is a qualifying input: an explicit
user choice. When the kind is `sent`, the suggestion carries a note: "This page may expect a code sent to you, not your
authenticator code." A wrong code can count toward a site's lockout, so Sixkey never retries a fill by itself (§8.4).

### 3.2 Keywords (data in the engine, not UI strings)

| Language | TOTP-like (positive)                                                                                                            | Sent codes (soft negative)                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| en       | verification code, security code, authentication code, one-time code, passcode, authenticator, two-factor, 2-step, 6-digit      | text message, SMS, sent to your phone, email |
| zh-Hans  | 验证码, 动态码, 动态口令, 安全码, 校验码, 两步验证, 二次验证, 身份验证器, 认证码                                                | 短信, 手机, 邮箱验证码, 发送至               |
| zh-Hant  | 驗證碼, 動態密碼, 安全碼, 兩步驟驗證, 驗證器                                                                                    | 簡訊, 手機                                   |
| es       | código de verificación, código de seguridad, código de autenticación, verificación en dos pasos, autenticador                   | SMS, mensaje de texto, correo                |
| de       | Bestätigungscode, Sicherheitscode, Authentifizierungscode, Einmalcode, Zwei-Faktor, Prüfcode, Verifizierungscode                | SMS, per E-Mail                              |
| fr       | code de vérification, code de sécurité, code d'authentification, double authentification, authentificateur, code à usage unique | SMS, par e-mail                              |
| ja       | 確認コード, 認証コード, ワンタイムパスワード, セキュリティコード, 2段階認証, 認証アプリ                                         | SMS, ショートメッセージ, メール              |
| ru       | код подтверждения, код проверки, одноразовый код, код безопасности, двухфакторная, аутентификатор                               | СМС, SMS, по почте                           |
| pt       | código de verificação, código de segurança, código de autenticação, verificação em duas etapas, autenticador                    | SMS, mensagem de texto, e-mail               |
| ko       | 인증 코드, 인증번호, 보안 코드, 일회용 비밀번호, 2단계 인증, OTP                                                                | 문자, SMS, 이메일                            |
| it       | codice di verifica, codice di sicurezza, autenticazione a due fattori                                                           | SMS, e-mail                                  |

Matching: NFKC, lower case, accents folded (the same folding as `match.ts` `normalizeName`). Words are matched on word
boundaries for Latin scripts and as substrings for CJK. Native speakers review the list before release (§11.4).

### 3.3 Segmented inputs

- **Group detection:** 4–8 sibling inputs, each with `maxlength="1"` (or one-character width with a numeric hint), in
  document order under a common ancestor within 3 levels, of equal size and on one line. A group counts as one candidate
  of length N. Fill only when N equals the account's `digits` (6 or 8). Otherwise ask in the popup.
- **Fill strategies,** tried in this order unless a rule pins one. At most two are tried, and the result is always checked
  by reading the values back:
  1. **per-char:** for each box, focus it, set the value, then dispatch `input` (bubbles, composed) and `change`.
     Auto-advance handlers are not needed because each box is set directly.
  2. **paste:** dispatch a synthetic `ClipboardEvent("paste")` whose `clipboardData` is a new `DataTransfer` holding the
     code, on the first box. Many OTP components split pasted text across the boxes. **The system clipboard is never
     touched** [inferred; Chrome constructing `ClipboardEvent` with `clipboardData` is [unverified], probe P8].
  3. **insertText:** `document.execCommand("insertText")` per box, for components that ignore untrusted events
     [unverified that the resulting `input` events are trusted; deprecated API, keep as a rule-only strategy].
- **Success** means the boxes, read back in order, equal the code. Otherwise stop, leave what the page shows, and say "Could
  not fill this page: type the code" with the code visible in the popup.

### 3.4 Framework-controlled inputs (React, Vue, Angular, Svelte)

- React keeps a value tracker on the element in the **page's** world. An isolated-world script sees its own wrapper of
  the element, so a plain `el.value = code` calls the native setter, React's tracker is not updated, and the following
  `input` event makes React see a change and fire `onChange` [inferred; the "native setter" trick is needed only in the
  main world]. Fixtures must prove this for React 18 and 19 (§11.1).
- Vue `v-model` listens to `input` (`change` with `.lazy`). Angular's default accessor listens to `input`. Svelte's `bind:value`
  listens to `input`. Dispatch `input`, then `change`, both with `bubbles: true` [inferred].
- Events dispatched from an isolated world have `isTrusted: false`. A page that rejects untrusted input events cannot be
  filled without the `debugger` permission, which is out of question. The fallback is the visible code in the popup.

### 3.5 Shadow DOM and frames

- **Open shadow roots** are walked (`element.shadowRoot`), to a depth of 8. **Closed roots are not walked.** Chrome has a
  content-script API for closed roots [unverified: `chrome.dom.openOrClosedShadowRoot`], which is held back until a real
  site needs it.
- **Frames, Stage 1:** `executeScript` with `allFrames: true` reaches the frames `activeTab` covers [unverified for
  cross-origin, probe P2]. Each result carries its `frameId` and `documentId`.
- **Frames, Stage 2:** the registered script uses `allFrames: true` and `matchOriginAsFallback: true` (Chrome 119+), so
  `about:blank`, `srcdoc` and `blob:` frames created by a granted origin are included [verified semantics].
- **Fill policy for frames** (§5.1 rule M4): fill a frame only if its own origin and the top frame's origin are **both**
  covered by registered domains of the **same** account. That allows `auth.example.com` inside `www.example.com`, and
  blocks a hostile page that frames a real login page.

### 3.6 Late fields in single-page apps, and the performance budget

- The Stage 2 content script runs at `document_idle` and scans once. It then watches with one `MutationObserver` on
  `document` (`childList`, `subtree`; no attributes, no character data). Only added subtrees are scanned, coalesced to one
  scan per 250 ms with `requestIdleCallback`, and capped at 40 scans a minute.
- It stops observing once a suggestion has been shown and used or dismissed, and restarts on the next URL change
  (`popstate`, or the Navigation API when present). It gives up after 10 minutes on one URL with no candidate.
- **Budget** [estimate targets, enforced by a benchmark fixture of 10,000 nodes]: content script at most 8 KB gzip; idle
  cost under 1 ms median per mutation batch and under 5 ms at the 95th percentile; under 50 ms of CPU per page-minute.

### 3.7 Several candidates on one page

The best score wins if it leads by 20 or more. Otherwise the popup lists the candidates, each identified by its label
text and highlighted in the page while the pointer is over its row (a CSS outline set by an injected call and removed
afterwards). An automatic suggestion attaches to the focused candidate only.

### 3.8 False positives: only offer when a matching account exists

Detection never shows anything by itself. A suggestion requires a candidate (score threshold), **and** an account in the
`registered` tier for the page (§5), **and** an unlocked vault that can compute the code (§10). A search box with
`maxlength="6"` scores −60 or less and never qualifies. A phone-number field is caught by its type and name tokens. An
SMS or email code page with a matching TOTP account gets the "sent code" note.

---

## 4. Content-script architecture and the fill path

### 4.1 Components

| Piece                   | Where it lives                                                      | Holds secrets?               | Size target                             |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------- | --------------------------------------- |
| Detection + fill engine | `src/inject/otp.ts`, built as `inject/otp.js`, no imports           | never                        | ≤ 8 KB gzip [estimate]                  |
| Stage 2 content script  | the same file, registered for granted origins                       | never                        | same file                               |
| Popup Fill UI           | a lazy chunk of the popup, loaded only when the tab has a candidate | the code, for one call       | not counted in the popup's static graph |
| Matching                | `core/match.ts` (exists)                                            | no                           | already in the popup                    |
| Code computation        | the popup (Stage 1); the worker when it holds the VK (Stages 1–2)   | yes, extension contexts only | unchanged                               |
| Rule store              | the worker; extension IndexedDB (§6.4)                              | no (public data)             | baseline ≤ 250 KB gzip in the package   |

### 4.2 Prerequisites before any code runs in a page (security hardening)

`executeScript` injections run as content scripts with the extension's ID. **Items 1 and 3 block Stage 1. Item 2 blocks
Stage 2 (K2).**

1. **Sender checks** (done in AUTOFILL-PRE, with the exact-path rules in `src/platform/sender-policy.ts`). Every privileged `onMessage` listener (`sw.ts:116`, `offscreen/main.ts:38`) accepts a message only if
   `sender.id` is ours, `sender.url` has our extension origin, and **`sender.tab` is absent or the URL is one of our own
   pages**. Content-script messages go to a separate listener with its own closed message set (§4.3). A unit test sends
   each existing message type with a content-script-shaped sender and expects it to be ignored.
2. **`chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})`** at the worker's top level, so a content
   script (or a compromised renderer acting as one) cannot read the vault slots, `sk_keyring` or `sk_pin`. Probe P1 must
   show that it works on Chrome 120 and persists before the worker runs.
   _Answered later (AUTOFILL2-PLAN-REVIEW M5): it does not work before Chrome 140 (the method arrives with Chromium
   a8f1f337); Stage 1 now injects nothing unless both areas are confirmed closed (AUTOFILL1-NOTES §17)._
   - **If it does not, K2 fires:** no registered content scripts, so Stage 2 is cut.
   - _Superseded by the note above: the two points below describe a Stage 1 that injects whatever the access level. Stage 1
     now injects nothing where `storage.local` cannot be closed, and the exposure they describe was larger than they say
     (writes and deletion too, and the whole vault for a device-key vault)._
   - Stage 1 can still ship, but not because its injections are short-lived. A renderer that has hosted one of our
     injections can probably keep using content-script APIs as Sixkey for the life of that process [inferred; P1 checks
     it].
   - The exposure is then limited to pages where the user clicked Fill. The attacker needs a renderer exploit on that
     page, and gets only the **encrypted** vault and keyring, for an offline guess against the master password, as with
     A3 (§9 has the row).
3. **`storage.session` stays at its default** (trusted contexts only) [verified default], with a test that asserts it.

### 4.3 The content-script channel (Stage 2)

- Messages from content scripts carry **enums and small integers only**: `{t: "cand", score, kind, n}` (a candidate
  appeared), `{t: "use"}` (the user clicked our suggestion), `{t: "gone"}`. The worker ignores every field it does not know,
  and every URL or origin a message claims.
- The worker takes the page's identity from `sender.origin`, `sender.url`, `sender.frameId` and `sender.documentId` (set by
  the browser), and the top frame's URL from `sender.tab.url` [verified fields]. Whether the browser enforces these for a
  compromised renderer under Site Isolation is [unverified], which is why rule M4 also requires the account's domain.
- The worker's answers: `{show: false}`, or `{show: true, label, host}`, where `label` is the account's display name and
  `host` is the registered domain that matched. There is never a code in an answer, never an account list, and never an
  answer for an origin other than the sender's.
- **No `window.postMessage`, no DOM events, no attributes or globals visible to the page** are used for anything.
- Rate limit: the worker answers at most 10 candidate messages per tab per minute and keeps no record after that.

### 4.4 Filling: the code travels in one call, to one document

1. The user consents in a trusted surface: the popup's Fill, the shortcut, or a trusted click on the Stage 2 suggestion.
2. The extension context computes the code for **that** account, with the time-window rule (§8.2).
3. It calls `chrome.scripting.executeScript({target: {tabId, documentIds: [docId]}, func, args: [code, expectedOrigin,
fieldToken]})`. Here `docId` is the document that was inspected, and `fieldToken` is a random value the detection pass
   kept in the isolated world for the chosen field [verified API shape; inferred: isolated-world state persists between
   injections into the same document, probe P2].
4. The injected function checks `location.origin === expectedOrigin` and that the field with that token is still
   connected and visible. Then it fills and returns `{ok}`. If the document changed (navigation, reload), the
   `documentId` no longer exists and the call fails: nothing is written [inferred].
5. Nothing is kept: no code in the isolated world after the call, no log, no clipboard.

**Compared with sending the code to a long-lived content script:** passing it as `args` to a pinned call means the
content script never has a "give me the code" path that a crafted message could use. With a compromised renderer, both
designs leak the code to that renderer at fill time, which is unavoidable. Only the pinned call also guarantees the code
went to the document the user saw.

### 4.5 The in-page suggestion (Stage 2) and DOM clickjacking

Marek Tóth's DEF CON 33 research (2025) hid password-manager UI injected into the DOM by setting opacity on it or on
`html`/`body`, overlaying it, or using top-layer popovers. One disguised click then filled credentials, cards and TOTP
codes. For TOTP and credentials the attacker needs script on a matched domain (XSS, subdomain takeover). Autofill into
subdomains widened the attack. Most vendors patched by January 2026 [verified, author's blog; the 2026 status is the
author's].

What Sixkey's suggestion must do [inferred from that research and IntersectionObserver v2]:

1. **Exact hosts only.** It appears only on granted origins (exact hosts), for `registered` matches, never through an
   alias.
2. **Closed shadow root, top layer.** It lives in a closed shadow root in a host element added at the end of `<body>`,
   shown as a `popover="manual"` element in the top layer. The host element's style is reset (`all: initial`).
3. **Visible before it can be clicked.** It accepts a click only if an `IntersectionObserver` with `trackVisibility: true`
   has reported `isVisible` for at least **800 ms**. `isVisible` never gives false positives [verified, web.dev]. If it is
   unavailable, or reports false, the suggestion turns into "Press Alt+Shift+F to fill" and is not clickable.
4. **Trusted events only.** The click must be a trusted `click` with a preceding trusted `pointerdown` on the same element,
   and `elementsFromPoint` at the pointer must return our host first.
5. **Hide on tampering.** A `MutationObserver` on our host, `html` and `body` (style and class attributes), plus a check of
   computed opacity, hides the suggestion on any change. It also hides when another top-layer element opens.
6. **Never on a page-driven focus alone.** A field focused by script (for example `autofocus`, or `el.focus()`) does not
   show the suggestion. It needs a trusted pointer or key event on the field, or a rule's `twoFactorPage` match plus a
   score of 100 or more.
7. **Text says where it fills:** "Fill code for GitHub · github.com" / "填写 GitHub 的验证码 · github.com".

The badge path (`setBadgeText` on the tab) and the shortcut are always offered alongside. The page cannot see or style them.

### 4.6 What a hostile page can learn (enumeration)

- **Stage 1:** nothing before the user acts. After a fill, the page sees the code it asked for.
- **Stage 2:** the content script runs only on granted sites. There, the suggestion's appearance tells the site that the
  user has a Sixkey account for it. The site already knows the user has 2FA, because it is asking for the code. A site
  that was **not** granted gets no content script and so cannot probe [inferred].
- **`declarativeContent` icon:** it reflects only the page's own fields and nothing about the vault. The page cannot read
  the toolbar [inferred].
- **Stage 4 (if approved):** the content script runs everywhere, but it changes the DOM only on a `registered` match, and
  "Possibly related" never shows anything. A lookalike or unrelated page therefore sees no difference [inferred].

---

## 5. Matching accounts to sites

### 5.1 Rules (building on `core/match.ts`)

- **M1.** Only the `registered` tier fills: the page's host is an account's registered domain or a subdomain of it, on
  label boundaries, compared in punycode [verified behaviour]. Rules and alias lists never add a domain to an account;
  only the user does ("Remember this site", the Sites field).
- **M2.** "Possibly related" (the issuer name guess) **never fills and never suggests automatically**. The popup lists such
  accounts, and "Fill" on one first asks "Remember github.com for GitHub?", showing the exact host. Registering the domain
  is the fill's precondition.
- **M3.** Phishing: no decoding of punycode for matching or display. The suggestion and the popup show the matched host
  as ASCII, so `xn--ggle-0nda.com` never looks like `google.com` [verified match rules]. A lookalike host never matches a
  registered domain [verified: suffix match on label boundaries].
- **M4.** Frames: fill only where the frame origin and the top origin both match the same account (§3.5).
- **M5.** Scheme: automatic suggestions only on `https:`. The popup can fill on `http:` only for IP hosts and `localhost`
  (registered exactly, which `match.ts` allows for IPs). Any other `http:` page gets a warning ("This page is not secure.
  Fill anyway?") [inferred policy].
- **M6.** Subdomains: `registered` covers subdomains (today's rule). Automatic suggestions are narrower: the granted origin
  is an exact host. A fill from the popup on a subdomain other than the registered host shows that host in the button
  ("Fill on login.example.com").

### 5.2 Alias domains

- Apple's `quirks/shared-credentials.json` (MIT) groups sites that use the same credential backend [verified file and
  licence]. Bitwarden's equivalent-domains table (`GlobalDomains` in `bitwarden/server`, AGPL-3.0) has groups such as
  google.com/youtube.com/gmail.com [verified content], but is not imported (§6.6).
- **Use:** when the page's host is in a group with an account's registered domain, the popup shows that account under
  "Same sign-in as live.com" with the page's host, and the fill asks to register the page's host first (M1). Aliases never
  trigger an automatic suggestion.

### 5.3 Accounts with no site, and several accounts per site

- **No site registered:** the popup's normal list still works. "Fill into the box that has focus" is offered from any
  account's menu with the warning "This account has no site. Check that this is the right page." Using it once offers
  "Remember github.com for this account".
- **Several matches:** the suggestion reads "Fill code: 2 accounts" and opens the popup to choose, showing labels
  (`alice@`, `work`). The shortcut fills only when there is exactly one match; with more, it opens the popup
  (`action.openPopup`, Chrome 127+ [unverified gesture rule]) or sets the badge.

---

## 6. The data: sources, our corpus, packaging and licence

### 6.1 What can be collected, and the licences

| Source                                                                                             | What it gives                                                                                     | Licence [status]                                                                                                                                                                         | Use                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **2fa.directory** (`2factorauth/twofactorauth`, `api.2fa.directory` v3/v4 `totp.json`, PGP-signed) | which domains support TOTP, `additional-domains`, documentation links; **not** where the field is | **MIT**, code and data. Attribution "Data sourced from 2FA Directory by 2factorauth" when the data is visible to users. The images in `img/` are excluded [verified README and API page] | seed list of domains to write rules for; the "Sites that support authenticator codes" hint in Settings, with attribution |
| **Apple password-manager-resources**                                                               | shared-credential groups, change-password URLs, `websites-that-append-2fa-to-password.json`       | **MIT** [verified]                                                                                                                                                                       | alias suggestions (§5.2); a "do not fill into the password field here" flag                                              |
| **Bitwarden equivalent domains**                                                                   | alias groups                                                                                      | **AGPL-3.0** (repo default; "-only" or "-or-later" [unverified])                                                                                                                         | not imported in this train (§6.6)                                                                                        |
| **ente auth `custom-icons.json`**                                                                  | titles, slugs, `altNames` (some are hosts)                                                        | repo AGPL-3.0 [unverified]                                                                                                                                                               | no: names, not domains; logos are trademarks                                                                             |
| **Aegis icons**                                                                                    | icon pack                                                                                         | **CC0-1.0** for "templates, texts, codes and some of the icons"; the rest belongs to credited sources or trademark owners [verified]                                                     | no: icons are out of scope                                                                                               |
| **2FAuth**, **Proton Pass**                                                                        | no public issuer-to-domain dataset found                                                          | AGPL-3.0 / GPL-3.0 [unverified]                                                                                                                                                          | no                                                                                                                       |
| **Public suffix list**                                                                             | registrable domains                                                                               | **MPL-2.0** [verified]                                                                                                                                                                   | no: rejected for size (§0.3)                                                                                             |
| **`/.well-known/change-password`** (W3C)                                                           | a URL convention                                                                                  | a specification, not a dataset                                                                                                                                                           | no                                                                                                                       |
| Chrome's affiliation data, Mozilla, EFF                                                            | no public TOTP-entry dataset found                                                                | n/a [unverified absence]                                                                                                                                                                 | no                                                                                                                       |

**Only one kind of source can tell where the field is: our own corpus.** The others tell which sites support TOTP.

### 6.2 The rule corpus: schema

One JSON file per site in `rules/sites/<registrable-name>.json`, validated by `rules/schema/rules.schema.json` (JSON
Schema 2020-12, `additionalProperties: false` everywhere). Fields:

| Field                   | Type and limits                                                                                                                                                                 | Meaning                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `id`                    | `^[a-z0-9-]{1,64}$`                                                                                                                                                             | stable rule id                                                |
| `domains`               | 1–16 canonical hosts (`match.ts` `canonicalHost`)                                                                                                                               | where the rule applies; **never** used to match accounts (M1) |
| `pages[]`               | 1–8 entries                                                                                                                                                                     | independent alternatives, not steps                           |
| `pages[].path`          | literal path prefix, optional single trailing `*`, ≤ 128 characters                                                                                                             | the 2FA step's URL path                                       |
| `pages[].field`         | CSS selector from a restricted grammar: type, `#id`, `.class`, `[attr]`, `[attr=value]`, `[attr^=value]`, descendant and child combinators; ≤ 200 characters; no pseudo-classes | the code box, or the first box of a group                     |
| `pages[].segments`      | integer 0 or 4–8                                                                                                                                                                | 0 for a single box                                            |
| `pages[].fill`          | enum `auto`, `per-char`, `paste`, `insert-text`                                                                                                                                 | strategy (§3.3)                                               |
| `pages[].twoFactorPage` | boolean                                                                                                                                                                         | the URL is known to be the 2FA step (timing trigger, §8.1)    |
| `flags`                 | subset of `appends-to-password`, `sent-code-only`, `no-auto`                                                                                                                    | engine behaviour switches, each implemented in the package    |
| `verified`              | date `YYYY-MM-DD`                                                                                                                                                               | last time CI or a maintainer saw it work                      |
| `fixtures`              | 1–8 paths under `rules/fixtures/`                                                                                                                                               | the synthetic pages that test it                              |

**There are no expressions, conditions, sequences, waits, clicks, script strings or regular expressions** (§7.1).
Auto-submit is not representable.

### 6.3 Contribution workflow and CI

- A contributor adds or edits `rules/sites/x.json` and at least one **synthetic** fixture: a minimal HTML page they wrote
  that reproduces the field's structure. Saved pages of real sites are not allowed (they are the site's copyrighted
  content and may contain personal data).
- **CI** runs four checks:
  1. validates every rule against the schema, plus the extra checks the schema cannot express (canonical hosts, the
     selector grammar, unique ids, no rule covering a shared suffix per `site-domains.ts`);
  2. runs each rule's fixtures in Playwright with the built `inject/otp.js` and expects the fill;
  3. runs the whole negative fixture set and expects no fill;
  4. checks the bundle size budget.
- DCO sign-off as for the rest of the repository. A rule older than 365 days with no `verified` refresh is flagged in a
  scheduled report, not removed.
- **Reporting a failing page without telemetry:** a popup menu item "This page didn't work" builds a **local** draft:
  the URL's host and path (no query, no fragment), the candidate fields' tag, type, `autocomplete`, `inputmode`,
  `maxlength`, and attribute **names** (values only for `name`, `id` and `autocomplete`, which the user sees and can
  delete). It never includes field values or page text. The user reviews the draft and clicks "Open issue on GitHub",
  which opens a prefilled new-issue URL in a tab. Nothing is sent by Sixkey itself.

### 6.4 Packaging, lazy loading and size

- **Build:** `rules/sites/*.json` becomes `dist/rules/baseline.json` (minified, one file, with `version` and `sha256`). It
  is **never inlined into a JavaScript chunk**, for licence clarity (§6.5) and so the popup graph never sees it. A
  check-dist test fails if a JS file contains a rule id.
- **Loading:** the worker cannot `import()` (§1.1). At install and update, it reads `rules/baseline.json` once with
  `fetch(chrome.runtime.getURL(...))`. That needs `'self'` in the manifest's `connect-src` (today only the API origin)
  [inferred that `connect-src` applies to own-package fetches; probe P3], and a deliberate exception to check-dist's
  single-`fetch` rule: one function in `platform/package-data.ts` that accepts only paths under `/rules/`. The worker then
  writes an index keyed by registrable name into **extension IndexedDB** (not readable by content scripts). After that,
  a lookup for a matched domain reads one record. A content script receives only its own origin's rule, on its first
  message.
- **Budgets:**
  - **Popup.** The 60 KB popup budget is **not raised**; it has 1.8 KB of headroom today (§1.2). The popup injects the
    engine with `executeScript({files: ["inject/otp.js"]})`, so the engine's code is never in the popup graph. Fill
    calls a two-line `func` against the state the file left in the isolated world. The popup's static growth target is
    **at most 0.5 KB gzip** [estimate]. All Fill UI is a lazy chunk, loaded only when the tab has a candidate.
  - **Catalogs.** The lazy chunk has its own catalog `autofill-<lang>.json`, because the full zh_CN catalog has 0.1 KB left.
  - **Proposed new check-dist budgets:** `inject/otp.js` ≤ 8 KB gzip; `rules/baseline.json` ≤ 250 KB gzip; autofill
    catalogs ≤ 4 KB gzip each.
- **Size of 5,000 rules:** a synthetic corpus of 5,000 full rules (domains, one page, selector, strategy, date) measured
  **924 KB raw, 74 KB gzip, 58 KB Brotli**. Domain-only entries measured 196 KB raw and 28 KB gzip [measured on synthetic
  data]. Real hosts and selectors repeat less, so expect **about 1 MB raw and 100–200 KB gzip** for 5,000 real sites
  [estimate]. Most sites need no rule because the heuristics find their field, so the real corpus will be much smaller.

### 6.5 Licence plan (owner decision D1: AGPL-3.0-or-later)

- **Where:** a new top-level component `rules/`, beside `api/` and `contract/`, so the licence boundary is a directory:
  `rules/sites/`, `rules/schema/`, `rules/fixtures/`, `rules/tools/` (the validator and bundler), `rules/NOTICE`. A
  separate repository (`sixkey-rules`) is possible later. In the monorepo, the CI can run rules against the current engine
  in one change, which matters more early on.
- **REUSE.toml:** add an annotation `path = ["rules/**"]`, `SPDX-License-Identifier = "AGPL-3.0-or-later"`, after the
  general entries (the last match wins), and extend the documents entry to `rules/**/*.md` (CC-BY-4.0). LICENSE.md's
  table gets a row. The AGPL text already exists in `LICENSES/`.
- **`rules/NOTICE`, in plain words:** what is covered (the rule files, the schema, the fixtures, the tools, and every
  bundle built from them); what is not (the Sixkey extension's engine, MPL-2.0; a user's vault); the project's reading that
  a program which only reads a bundle as input is not thereby a work based on it (§6.6 item 3); where the Corresponding
  Source is (the repository at the tag or commit named in each bundle's manifest); and the required attributions.
- **Package:** `dist/rules/baseline.json` plus `dist/rules/LICENSE.txt` (the AGPL text and the notice). `dist/LICENSE.txt`
  gains a paragraph: "The files under rules/ are licensed AGPL-3.0-or-later; source: <repository URL>, tag <version>."
  `THIRD-PARTY-NOTICES` gains entries for 2fa.directory (MIT, with its attribution) and Apple password-manager-resources
  (MIT), generated by `scripts/notices.mjs` from `notices-data.mjs`.
- **UI attribution:** where the 2fa.directory list is shown (Settings › Autofill › "Sites known to support authenticator
  codes"), the line "Data sourced from 2FA Directory by 2factorauth" appears [verified requirement].

### 6.6 Legal fit of AGPL for a data corpus (the decision stands; risks and fixes)

This is engineering analysis, not legal advice. An external licence review before release is worth a few hours.

1. **AGPL on data.** The FSF says the GPL family can apply "to any kind of work, as long as it is clear what constitutes
   the 'source code'" [transcribed, mirror of the GNU FAQ].
   - **Source:** the per-site JSON files, the schema and the bundler. **Object form:** the minified bundle.
   - **What is protected:** individual facts (site X has a code box matching selector Y) are weakly protected or not at
     all. The selection and arrangement as a compilation may be. So may the EU database right, if AGPL's "copyright-like
     laws that apply to other kinds of works" covers it [inferred, untested in court].
   - **Practical effect:** AGPL restrains wholesale copying of the corpus. It cannot stop anyone from writing their own
     rules by looking at the same sites.
2. **Conveying and §13.**
   - **Conveying:** shipping the bundle in the extension, or serving it as a download, is conveying. The recipient gets
     AGPL rights and must pass them on with the Corresponding Source when they redistribute it, modified or not (§4–6).
   - **§13 network clause:** it applies to someone who **modifies** the corpus and lets users **interact with it remotely**,
     for example a server API that answers "rules for site X" from a modified corpus. A static download is conveying,
     not remote interaction [inferred].
3. **A competitor that only downloads and uses the bundle.** The FSF's position on interpreters is that the interpreted
   program "is just data" to the interpreter, and output is generally not covered [transcribed]. By the same reasoning, an
   engine that reads the bundle as input is not a work based on it. Copyleft applies to the corpus and to modified
   versions of it [inferred].
   - **The risky case** is embedding the data in the engine's own files, for example inlining the rules into a JS bundle.
     Being "in the same executable" is the FSF's mark of combination [transcribed]. Sixkey avoids that by keeping the
     data in separate files (§6.4).
   - The owner should know that **AGPL does not make a competitor's extension open source**. It keeps the rule data and
     its derivatives open.
4. **Data-oriented alternatives, for comparison:**
   - **ODbL-1.0** was written for databases. It is share-alike on adapted databases, attribution is required for produced
     works, and it also covers database rights [verified summary; database-rights coverage from the full text,
     unverified]. It is not compatible with the GPL family.
   - **CC BY-SA 4.0** is one-way compatible with GPLv3 (declared 8 October 2015). AGPLv3 is not named in that declaration
     [verified]. Material under it could reach an AGPL corpus only through GPLv3 §13's combination clause [inferred].
   - **AGPL-3.0-or-later**, as decided, matches the server, is familiar to contributors, and composes with MIT inputs. Its
     weak point is the data-versus-source ambiguity, which the NOTICE fixes in plain words.
   - **Recommendation:** keep AGPL-3.0-or-later (D1), with the NOTICE of §6.5. Do not add a second licence: with DCO and no
     CLA, community rules can never be relicensed, and that is consistent with D1.
5. **Licence mixing inside our package.**
   - The MPL-2.0 engine carries no "Incompatible With Secondary Licenses" notice [verified], so it is GPL-family-compatible
     (MPL-2.0 §3.3).
   - The AGPL data sits in separate files read at runtime, which is close to AGPL §5's "aggregate" [inferred]. Even if it
     counted as a combined work, everything in it is already published as source under compatible terms. Sixkey therefore
     meets AGPL's source obligation whichever reading applies [inferred].
   - A fork of the extension has the same position.
6. **Inbound data.**
   - **Compatible with AGPL redistribution:** 2fa.directory (MIT, with attribution) and Apple's resources (MIT) [verified].
   - **Bitwarden's list** is AGPL-3.0. If it is "-only" [unverified], material from it would pin those parts to AGPL-3.0-only
     and complicate the "-or-later" statement. Leave it out for now; Apple's list covers the same need.
   - **ente and 2FAuth** (AGPL [unverified]): compatible in principle, but no useful data.
   - **Icon packs:** out of scope, because they are trademark material.
   - **Facts a contributor reads on a site's own help page** may be restated in our words.
7. **DCO is enough** for the repository's convention [inferred]. DCO 1.1 (a) and (b) certify the right to submit "under
   the open source license indicated in the file". This repository indicates licences only in `REUSE.toml` (no headers),
   and CONTRIBUTING says contributions take the licence of the files they change [verified]. `rules/CONTRIBUTING.md` adds
   two lines: rules and fixtures are AGPL-3.0-or-later; do not copy from sources with incompatible licences, and write
   fixtures yourself.
8. **The live bundle (§7).** For our own rules, we are the licensor, so publishing them triggers nothing. For community
   rules, we are a licensee and must offer the source. The public repository tagged per bundle version, with the bundle
   manifest's required `source` and `license` fields pointing to it, does that [inferred].
   - A third party that hosts a modified bundle must do the same: publish the modified rule files and the bundler, and
     name them in their manifest. The schema makes those two fields mandatory, so a compliant fork is the easy path.
9. **"Never gated"** is not affected. The baseline ships free in every release, and live updates are free with no
   account (D2).

---

## 7. Cloud-maintained rules: what is and isn't possible

### 7.1 Code versus data: where the line is

| Remotely delivered                                                                                                                    | Allowed?                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript, WASM, `eval`, `new Function`, a remote `<script>`                                                                         | **No**: remotely hosted code [verified policy]                                                                                                                                 |
| "Logic for finding input fields" as code (functions, scripts, regex programs)                                                         | **No**, same rule. The owner's original idea (D6) is not possible in an MV3 store extension [verified policy]                                                                  |
| A rule DSL with conditions, loops, sequences of actions ("click X, wait, type")                                                       | **No**, or at least indefensible: "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data" [verified policy] |
| JSON data in a closed schema: domains, path prefixes, restricted CSS selectors, enums for strategy and flags, bounded integers, dates | **Yes**: data and "things like JSON or CSS"; remote configuration "determining enabled features" with "all logic … in the extension package" [verified policy]                 |

**The safe schema rule:** every field must be a value the packaged engine already handles with packaged code. New
behaviour needs a new enum value and therefore a new extension release. Selectors use a restricted grammar, so they are
queries, not programs (no `:has()`, no pseudo-classes). Every bundle is validated by the same parser as the baseline, and
a bundle with an unknown field is rejected whole.

### 7.2 Privacy: no per-site lookups

Asking a server "what rules for example.com?" tells it which sites the user visits and where they have 2FA. That is
tracking, and is incompatible with PRIVACY.md. Hash-prefix sharding with k-anonymity still leaks a prefix of every
visited domain, and is not needed at this size.

**The only compliant design:** one file, the same for everyone, downloaded whole. Lookups happen locally (§6.4).

### 7.3 The update mechanism (owner decisions D2, D3)

- **Toggle**, Settings › Autofill, off by default:

  | Element | English                                                                                                                                                                                                                                                                                           | 简体中文                                                                                                                                                                                           |
  | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Label   | Get the latest site rules                                                                                                                                                                                                                                                                         | 获取最新网站规则                                                                                                                                                                                   |
  | Help    | About once a day, Sixkey downloads the same signed rules file that every Sixkey user gets, from rules.sixkey.app. No account is used, and no list of the sites you visit is sent. The server sees only that this browser downloaded the file. Off: Sixkey uses the rules built into this version. | Sixkey 大约每天一次，从 rules.sixkey.app 下载所有用户都相同的签名规则文件。不使用任何账户，也不发送你访问过的网站列表；服务器只能看到这个浏览器下载了该文件。关闭时，Sixkey 使用此版本内置的规则。 |

  Turning it on calls `permissions.request({origins: ["https://rules.sixkey.app/*"]})` in the click. Turning it off removes
  the permission.

- **Network:**
  - **Fetch:** a second pinned origin in the worker's transport, with its own request shape: `GET` only, no credentials,
    no cookies, no referrer, `Accept-Language: *`, no redirects, at most 2 MiB, one attempt, a 20 s timeout.
  - **Manifest CSP:** `connect-src` gains `https://rules.sixkey.app`.
  - **Pages:** their `connect-src 'none'` is unchanged. A page never fetches; the toggle asks the worker.
  - **check-dist:** gains exactly this second origin, and the single-`fetch` rule becomes "one transport module".
- **Consent is a setting plus the permission.** Once `https://*/*` is an optional pattern (Stage 2), a broad grant would
  also satisfy `permissions.contains` for the API and rules origins. From Stage 2 on, `api-permission.ts` and the rules
  updater must therefore check an explicit stored setting **and** the permission. The CSP remains the hard limit: no other
  origin can be reached whatever is granted [verified CSP rule; inferred interaction].
- **Cadence:** a daily `alarms` alarm (an existing permission). It fetches a small `manifest.json` with `If-None-Match`,
  and fetches the bundle only when its version changes.
- **Integrity:**
  - **Signature:** the manifest is `{schema, version (integer, increasing), created, sha256, minEngine, source, license}`,
    signed with **ECDSA P-256** (already used by Sixkey, available in WebCrypto on Chrome 120). Ed25519's WebCrypto
    availability across our version range is [unverified]. The signature input is domain-separated:
    `sixkey-rules|1|<canonical manifest>`.
  - **Pinned keys:** two public keys (current and next) ship in the package. The private key is offline, and each publish
    is a manual CI approval.
  - **Rejected:** a version not above the stored one; a version below the packaged baseline; a hash mismatch; an unknown
    field.
  - **Kept:** the last good bundle is kept, and the baseline is always the fallback.
  - **Key compromise:** recovery is an extension release with new pinned keys.
- **What the endpoint learns:** IP address, time, User-Agent, and (through the ETag) the last version held. CDN log
  retention is an infrastructure setting to state in PRIVACY.md.
- **Without the toggle:** the baseline of each release, with no network at all.

### 7.4 Account or no account (decided: none, D2)

A static signed file needs no identity. Tying downloads to an account would make every account's download times and IP
addresses linkable, for no security gain, because the signature already authenticates the data. Under D1 and D2, autofill
is not a revenue lever. Its value is product quality, and the paid tier remains hosted sync.

### 7.5 Open source versus moat (resolved by D1)

Anything inside the package, or downloaded by every client, is readable by anyone: a CRX is a zip, and a bundle can be
fetched by hand. A client-side "secret" corpus was never a technical moat. Under D1, the defensible advantages are
**freshness** (a verified daily bundle), the **verification fleet** (CI and scheduled Playwright runs against fixtures,
plus maintainers' manual checks on real sites), and the brand. AGPL keeps competitors from taking the corpus closed. The
engine stays MPL-2.0 so auditors can read everything that touches codes.

---

## 8. Timing: "at the right moment"

### 8.1 Triggers

| Trigger                                                                                  | Stage | Result                                                                                                             |
| ---------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| User opens the popup on a page                                                           | 1     | detection runs; the matched account gets a **Fill** button at the top                                              |
| User presses **Fill code**                                                               | 1     | one match: fill; several: popup; locked: popup to unlock                                                           |
| `declarativeContent` sees a one-time-code box                                            | 1     | toolbar icon variant (no vault information)                                                                        |
| Trusted pointer or key interaction with a candidate field (score ≥ 60) on a granted site | 2     | in-page suggestion and badge                                                                                       |
| Page load of a URL a rule marks `twoFactorPage`, score ≥ 100, on a granted site          | 2     | badge, plus the suggestion when the field gets a trusted interaction                                               |
| After a password submit                                                                  | none  | not used: detecting it needs `webNavigation` or page-wide listeners; the 2FA page's own field is the better signal |

### 8.2 The time window

Let r be the seconds left in the code's period. If r ≥ 5, fill the current code. If r < 5, show "New code in r s", wait
for the next window, then fill the next code, but only if the same document and field are still there and the user has
not dismissed. Never fill a code that is about to expire. RFC 6238 §5.2 recommends that servers accept at most one
previous step, but not every server does [inferred from RFC text, not re-read for this study]. The clock is the one
the code list already uses, including any correction sync adds later.

### 8.3 Frequency, dismissal and memory

- One suggestion per document. After a fill or a dismissal, nothing more on that document.
- **Esc** dismisses. "Not now" lasts for the document only (in memory).
- "Turn off for this site" removes the grant (§2.3). With per-site grants, no "never" list is needed, because the content
  script simply stops running there.
- The popup's "Not now" for the opt-in offer (§2.6) is a host set in `storage.session`. It is gone after a browser
  restart, so it adds no stored record, no key-change cleanup and no permanent-delete scrub.
- Stage 4 only: a durable "never on this site" list is needed there. It would be a VK-encrypted record. That brings it
  into the VkRecord contract (`core/sync/local/records.ts`: the key-change cleanup and the permanent-delete scrub), and
  that work is part of Stage 4's estimate.

### 8.4 Safety defaults

- No clipboard is used for filling. The existing copy feature is unchanged.
- **No auto-submit.** The schema cannot express it, and the engine has no code for it.
- No automatic retry. If a fill is rejected by the site, the user tries again.

### 8.5 Accessibility

- The suggestion is a real `<button>` in the closed shadow root, with the text of §4.5 as its name. It is announced once
  through a polite live region inside our host. Focus is never moved to it and never taken from the field.
- **Keyboard-only users:** the announcement says "Press Alt+Shift+F to fill". The shortcut fills the focused candidate.
  The suggestion is not inserted into the page's tab order.
- Esc dismisses, and Esc is consumed only while the suggestion is shown.
- The popup's Fill button follows the popup's existing focus and screen-reader rules. A fill result is announced ("Code
  filled" / "已填写验证码").

---

## 9. Security and privacy threats

| Threat                                                                                                  | Defence                                                                                                                                                                                                | Residual                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious page reads the code after a fill                                                              | Fill happens only after a trusted action on a registered match. One code, valid for at most one window.                                                                                                | Unavoidable: the page's own field is readable by the page                                                                                                                       |
| Malicious page triggers suggestions to learn which accounts the user has (enumeration)                  | No content script on sites that were not granted. Nothing in the DOM before a trusted interaction. "Possibly related" is never shown in the page. The worker answers only for the sender's own origin. | A granted site learns that the user has a Sixkey account for it, which it already knew (§4.6)                                                                                   |
| Malicious page or XSS asks for a code through messages                                                  | No code-request message exists (§4.3). Codes go out only as `args` to an injection the extension starts.                                                                                               | None known [inferred]                                                                                                                                                           |
| DOM clickjacking (invisible, overlaid or top-layer tricks)                                              | Closed shadow root in the top layer; IntersectionObserver v2 visibility for 800 ms; trusted pointer sequence; `elementsFromPoint`; tamper observer; exact-host scope (§4.5)                            | XSS on a granted site plus a determined attacker can still try. K3 drops the in-page UI if the tests fail                                                                       |
| Subdomain takeover or XSS on a subdomain                                                                | Automatic suggestions only on exact granted hosts (M6). Popup fills on other subdomains show the host.                                                                                                 | A user who registers a broad parent and clicks Fill on a taken-over subdomain                                                                                                   |
| Lookalike or IDN phishing domain                                                                        | Suffix match on label boundaries, punycode compared and shown as ASCII; "related" never fills (M2, M3)                                                                                                 | None for automatic suggestions; a user can still register a wrong host by hand                                                                                                  |
| Hostile top page frames a real login page                                                               | Frames fill only when the frame and top origins both match the same account (M4)                                                                                                                       | None known                                                                                                                                                                      |
| **Compromised renderer, Stage 2** (an exploited page on a granted site impersonates our content script) | Worker treats every content-script message as crafted (§4.3); `storage.local` closed to content scripts (§4.2, K2 cuts Stage 2 otherwise); no secrets in content scripts                               | It sees the codes filled into its own page                                                                                                                                      |
| **Compromised renderer, Stage 1** (an exploited page where the user clicked Fill)                       | Sender checks (§4.2 item 1); no code-request message; `storage.local` closed from Chrome 140; on 120–139 nothing is injected (STORAGEGATE, AUTOFILL1-NOTES §17)                                                                                                            | _Answered (P1: not before Chrome 140):_ on 120–139 Stage 1 injects nothing, so there is no such renderer; a renderer that hosted an injection before STORAGEGATE may keep `storage.local` access for its process's life (AUTOFILL1-NOTES §17) |
| Malicious extension                                                                                     | No `externally_connectable` (unchanged). Another extension can message us only through a page, and those messages carry no power.                                                                      | An extension with broad host access reads any field, ours included: unavoidable                                                                                                 |
| Sensitive pages (banks)                                                                                 | Nothing runs on a site unless the user granted it or clicked Fill there. Enterprise policy can block hosts (`runtime_blocked_hosts` [unverified name]).                                                | A user's own choice                                                                                                                                                             |
| Locked vault                                                                                            | Nothing appears in the page. The badge hints, and unlocking happens only in the popup. **A password is never collected in a page.**                                                                    | None                                                                                                                                                                            |
| Tier-2 (protected) account                                                                              | Never filled automatically. The popup fill requires the step-up (§10).                                                                                                                                 | None                                                                                                                                                                            |
| Rules bundle tampering, rollback or freeze                                                              | ECDSA signature with pinned keys, increasing versions, the baseline as the floor, a strict schema (§7.3)                                                                                               | A compromised signing key until the next release. The damage is bounded: rules can only steer a fill on a site the user already matched, or suppress one                        |
| Malicious rule contribution                                                                             | Rules never decide accounts (M1). CI checks the schema and selector grammar. Review is required to merge.                                                                                              | A wrong selector fills a wrong box on a matched site; the user sees it                                                                                                          |
| Rules endpoint as a tracker                                                                             | One file for everyone, no account, no per-site queries (§7.2)                                                                                                                                          | The endpoint sees IP and time, and only when the user opted in                                                                                                                  |
| Profile copy (A3)                                                                                       | The vault stays encrypted                                                                                                                                                                              | Chrome's plaintext list of granted sites (§2.5), disclosed                                                                                                                      |
| Sync                                                                                                    | Nothing autofill-related syncs (§0.7)                                                                                                                                                                  | None                                                                                                                                                                            |
| Logging                                                                                                 | **Nothing is logged.** No fill events, no hosts, in no log, the security record and `sk_diag` included                                                                                                 | None                                                                                                                                                                            |

---

## 10. Interplay with other designs

- **Vault lock rules.**
  - **Standard mode:** the worker can open the vault from `storage.session` and compute a code for the shortcut and the
    Stage 2 suggestion.
  - **"Lock every time" mode:** only the page that unlocked holds the VK, so both paths fall back to the popup ("Open Sixkey
    to fill").
  - **On lock:** a lock bumps `sk_lock_epoch`. The suggestion asks for the code only at click time, so a lock between
    showing and clicking turns the click into "Locked: open Sixkey". A suggestion expires after 60 s.
- **QUICK-UNLOCK.** While the PIN session holds the VK only under the PIN (`sk_quick`), nothing can fill until the PIN is
  typed in the popup. After that, tier-1 accounts fill as in standard mode. The PIN never unlocks tier-2 (that proposal's
  rule).
- **ADVANCED-RECOVERY-AND-TIERS.** Protected accounts' secrets are sealed under the HVK, which the worker and the PIN
  session never hold. They never get an automatic suggestion. A popup Fill requires the step-up, and the fill uses the
  code computed in the popup after it. If an owner wants a per-account "never autofill" flag, it joins that proposal's
  schemaVersion 3 revision (§0.7).
- **YubiKey reference entries** (`YUBIKEY-DESIGN.md`): their codes come from the native helper. Popup fill only [inferred].
- **Budgets.** The popup budget is not raised: at most +0.5 KB static, with Fill UI and strings in a lazy chunk and their own catalog. The full
  zh_CN catalog has 0.1 KB left, so the Settings › Autofill text goes in `autofill-<lang>.json`, as the Sync section's
  catalogs do (§6.4).
- **i18n.** UI strings in en and zh_CN (catalogs). The detection keywords (§3.2) are engine data, not UI strings, and are
  reviewed by native speakers.
- **Sync.** None. `domains` syncs as it does today.

---

## 11. Testing

### 11.1 Playwright against local fixture pages

The e2e build already grants permissions up front because tests cannot answer prompts. It would grant the fixture
server's origin and `scripting`. Fixtures are synthetic pages served from `127.0.0.1`. **One fixture per pattern:**

1. **Single box:** `one-time-code`; `inputmode=numeric maxlength=6`; `type=tel`; `type=number`; `type=password`.
2. **Label variants:** label only, `aria-label` only, placeholder only, `aria-labelledby` pointing outside the form, in
   every language of §3.2.
3. **Segmented:** 6 and 8 boxes with auto-advance; a paste-splitting component; a component that rejects untrusted
   events (expect a refusal, not a wrong fill).
4. **Frameworks:** controlled inputs in React 18 and 19, Vue 3 `v-model` (plus `.lazy`), Angular reactive forms, Svelte;
   and a pre-built `input-otp`-style component. All built into static fixtures, no network.
5. **Shadow DOM:** open root (fills); closed root (does not); nested open roots at depth 3.
6. **Frames:** a same-origin iframe; a cross-origin iframe under a matching account (fills under M4); a hostile top page
   framing a matching page (does not fill); `srcdoc` and `about:blank` frames.
7. **SPAs:** a field inserted 3 s after load; route changes; a 10,000-node page for the performance budget.
8. **Several candidates;** **negatives:** search box, phone, ZIP, card and CVV, CAPTCHA, coupon fields; SMS and email
   code pages (expect the note).
9. **Clickjacking set (K3):** opacity 0 on our host, `html` or `body`; a full overlay with `pointer-events: none`; a
   partial overlay; a top-layer popover above us; script focus without a user event. Each expects no fill.
10. **Time window:** a frozen clock at r = 4 s expects the next code at the boundary.

### 11.2 Corpus plan

There are about 120 fixtures at release [estimate]: the pattern set above, plus one per rule in the initial corpus. The
initial corpus covers the top 100 TOTP sites from 2fa.directory's list where heuristics alone fail, written by
maintainers [estimate].

### 11.3 Mutation targets

Tests must kill mutants in:

- `matchTier` / `coveredBy` (label boundary, IP exactness);
- the `registered`-only gate for fills;
- the frame rule M4;
- `location.origin` and `documentId` pinning in the injected fill;
- `isTrusted` and the 800 ms visibility gate;
- the content-script sender filter;
- the r ≥ 5 s rule;
- the rule schema validator (unknown fields, selector grammar);
- signature verification and rollback checks.

The server already runs mutation testing (`make mutants`). Using the same approach on these extension modules is
recommended.

### 11.4 Manual QA on real sites

These are candidate sites; their field shapes are [unverified].

| Group    | Sites                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive | GitHub, GitLab, Google, Microsoft (`login.live.com`, `login.microsoftonline.com`), AWS console, Cloudflare, Dropbox, Discord, Reddit, X, Facebook, npm, PyPI, Docker Hub, Atlassian, Proton, Coinbase, Binance, Namecheap, Auth0 Universal Login, an Okta-hosted login, 阿里云, 腾讯云, 华为云, Gitee |
| Negative | a bank's SMS page, Steam Guard (not standard TOTP), a search page, a phone-verification page                                                                                                                                                                                                          |

Run on macOS and Windows, en and zh_CN UI, with a screen reader (VoiceOver, NVDA) for §8.5. Native speakers check §3.2.

---

## 12. Staged plan: one release train (D4)

### 12.1 Stage 0: probes (3–4 days) [estimate]

| Probe | Question                                                                                                                                                                                                                                                                     | Kill link |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| P1    | Does `storage.local.setAccessLevel(TRUSTED_CONTEXTS)` work on Chrome 120, and does it hold before the worker runs and across restarts? After one `executeScript` into a page, can that renderer keep using content-script APIs (`storage`, `runtime.sendMessage`) as Sixkey? _Answered: no before Chrome 140 (§4.2)._ | K2        |
| P2    | Which frames does `activeTab` + `allFrames` reach (same-origin, cross-origin, `about:blank`)? Does isolated-world state persist between two injections into one document?                                                                                                    | —         |
| P3    | Does the manifest `connect-src` block the worker's `fetch(chrome.runtime.getURL(...))` without `'self'`?                                                                                                                                                                     | —         |
| P4    | Does `action.openPopup()` work from `commands.onCommand`, and from a content-script message, on 127+?                                                                                                                                                                        | —         |
| P5    | Chrome's exact per-site dialog text (en, zh_CN); registered scripts after grant, after `permissions.remove`, and under "On click" site access                                                                                                                                | —         |
| P6    | Draft upload of the Stage 2 + 3 manifest: does the dashboard show the in-depth-review notice for an **optional** `https://*/*`?                                                                                                                                              | K1        |
| P7    | IntersectionObserver v2 `isVisible` for a top-layer element inside a closed shadow root created by a content script                                                                                                                                                          | K3        |
| P8    | Synthetic `ClipboardEvent` with `clipboardData`; `execCommand("insertText")` event trust                                                                                                                                                                                     | —         |

### 12.2 The train

| Stage  | Contents                                                                                                                                                                                                                                    | Effort [estimate]                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Pre    | §4.2 hardening: sender checks in `sw.ts` and `offscreen/main.ts`, storage access level, tests                                                                                                                                               | 3–4 days                         |
| 1      | Engine (`inject/otp.ts`: detection, segmented, frameworks, fill); popup Fill (lazy chunk and catalog); `Fill code` command; matching rules M1–M6; time window; `declarativeContent` hint; fixtures 1–8 and 10                               | 2.5–3.5 weeks                    |
| 2      | Per-site opt-in (prompt, Settings › Autofill, `permissions.onAdded`/`onRemoved`); one registered content script; channel §4.3; worker code path; hardened suggestion §4.5; a11y; fixture set 9; Chrome 133 `addHostAccessRequest` path      | 3–4 weeks                        |
| 3      | `rules/` component: schema, validator, bundler, NOTICE, REUSE and notices; CI with Playwright; initial corpus; worker IndexedDB index; signed bundle pipeline (offline key, manifest, ECDSA verify, rollback); opt-in updater; rules origin | 3–4 weeks, plus ongoing curation |
| Review | Internal security review of the whole train against §9; external licence check (§6.6)                                                                                                                                                       | 1–1.5 weeks                      |
| 4      | All-sites mode, only if Q1 is yes, in a later release                                                                                                                                                                                       | about 1 week                     |

The train totals **about 10–14 weeks** [estimate]. Stage 1 is the smallest valuable piece and the minimal-risk subset
(§0.6). It stays separable in the code, so K1–K4 can cut the train at the stage boundary.

### 12.3 Applying the kill criterion

P6 runs in Stage 0, and the draft upload is repeated before submission. If K1 fires, the release carries Stage 1 and the
bundled Stage 3 corpus. The registered script, the optional `https://*/*` and the rules origin are removed from the
manifest, and their code paths are compiled out by a build flag, as `SYNC_UI_IN_STORE_BUILD` does for sync.

### 12.4 What changes outside the feature (listed, not edited here)

- **`extension/scripts/check-dist.mjs`:**
  - `PERMISSIONS` gains `scripting` (and `declarativeContent` if kept).
  - `COMMANDS` gains `fill`.
  - The optional host allow-list becomes {API origin, `https://*/*`, rules origin}.
  - `EXPECTED_CSP` `connect-src` gains `'self'` and the rules origin.
  - The single-`fetch` rule becomes the transport module plus `package-data.ts`.
  - New budgets for `inject/otp.js`, `rules/baseline.json` and the autofill catalogs.
  - A test that no JS file inlines rule data.
- **`docs/PRIVACY.md`:**
  - "No content scripts…" becomes: "Sixkey runs code in a page only when you click Fill or press the Fill shortcut, and,
    if you turn on suggestions for a site, a small script on that site only."
  - The tab-address sentence covers the shortcut.
  - A rule-updates paragraph is added.
  - The plaintext list of granted sites (§2.5) is disclosed.
- **`docs/ARCHITECTURE.md` §4:** the web-pages boundary is rewritten to describe §4.2–§4.4.
- **`docs/SYNC-DESIGN.md` §3.13:** the three decision rows of §0.7.
- **`LICENSE.md`, `REUSE.toml`, `THIRD-PARTY-NOTICES`:** §6.5.
- **Store listing (OWNER-DECISIONS 06):** one sentence on autofill and its permissions (Q2).

---

## 13. Unverified claims

1. Optional host patterns do not appear in Chrome's install prompt (§1.1, §2.1).
2. `activeTab` reaches cross-origin iframes in Chrome (P2).
3. `storage.local.setAccessLevel(TRUSTED_CONTEXTS)` works on Chrome 120 and persists before the worker runs (P1). _Answered: not before Chrome 140 (Chromium a8f1f337); see §4.2 item 2._
4. `action.openPopup()` gesture requirements (P4).
5. `addHostAccessRequest`'s user interface (§2.3).
6. Chrome's exact permission dialog text in en and zh_CN (P5).
7. Whether an optional `https://*/*` sets off the in-depth review, and whether a draft upload shows it (P6).
8. Whether Chrome enforces `MessageSender.origin` for a compromised renderer under Site Isolation (§4.3).
9. Chrome constructing `ClipboardEvent` with `clipboardData`; `execCommand("insertText")` event trust (P8).
10. `chrome.dom.openOrClosedShadowRoot` for closed shadow roots (§3.5).
11. The Chrome isolated-world CSP detail (§2.2).
12. Ed25519 in WebCrypto across Chrome 120+ (§7.3).
13. The Chrome version of IntersectionObserver v2 and its behaviour in closed shadow roots and the top layer (P7).
14. Whether Bitwarden's licence is "AGPL-3.0-only" or "-or-later"; the licences of ente, 2FAuth and Proton Pass (§6.1).
15. ODbL's database-rights coverage, from the full text (§6.6).
16. Edge store review differences; Firefox `documentIds` and `match_origin_as_fallback` support (§1.1).
17. The `runtime_blocked_hosts` policy name (§9).
18. RFC 6238's look-back recommendation, which was not re-read for this study (§8.2).
19. The field shapes of the manual QA sites (§11.4).
20. That no public TOTP-entry dataset exists from Chrome, Mozilla or EFF (§6.1).

---

## 14. Owner questions, in detail

| #   | Question                                                                                     | Recommendation                                                                                                  | What it blocks            |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q1  | Offer an optional "on all sites" mode (Stage 4)?                                             | Not in this train. Revisit after Stage 2 has real use. If yes, the broad prompt needs its own wording approval. | Stage 4 only              |
| Q2  | Approve the user-facing and store-facing wording (§2.6, §7.3, §12.4) in en and zh_CN         | Approve as drafted, after P5 supplies Chrome's own dialog text                                                  | Stage 2 UI; store listing |
| Q3  | Accept the 2fa.directory attribution in the product; leave Bitwarden's AGPL list out for now | Yes, yes                                                                                                        | Stage 3 data import       |
| Q4  | Accept kill criterion K1 with a 14-day review threshold                                      | Yes                                                                                                             | The submission decision   |

---

## 15. Sources

Chrome and the Chrome Web Store:

- activeTab: <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- permissions API: <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- permissions list: <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- permission warnings: <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- scripting API: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- content scripts: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- storage API: <https://developer.chrome.com/docs/extensions/reference/api/storage>
- runtime API: <https://developer.chrome.com/docs/extensions/reference/api/runtime>
- action API: <https://developer.chrome.com/docs/extensions/reference/api/action>
- declarativeContent: <https://developer.chrome.com/docs/extensions/reference/api/declarativeContent>
- Stay secure: <https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure>
- service worker basics: <https://developer.chrome.com/docs/extensions/mv3/service_workers/basics>
- network requests: <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- remotely hosted code: <https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>
- CWS MV3 requirements: <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- CWS permissions policy: <https://developer.chrome.com/docs/webstore/program-policies/permissions>
- CWS quality guidelines: <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines>
- CWS review process: <https://developer.chrome.com/docs/webstore/review-process>
- CWS help, managing extensions: <https://support.google.com/chrome_webstore/answer/2664769>

Standards and other browsers:

- WHATWG HTML autofill: <https://html.spec.whatwg.org/multipage/form-control-infrastructure.html>
- IntersectionObserver v2: <https://web.dev/articles/intersectionobserver-v2>
- Firefox MV3 migration: <https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/>
- Firefox bug 1839200: <https://bugzilla.mozilla.org/show_bug.cgi?id=1839200>

Clickjacking research:

- Marek Tóth, DOM-based extension clickjacking: <https://marektoth.com/blog/dom-based-extension-clickjacking/>

Data sources:

- 2fa.directory: <https://github.com/2factorauth/twofactorauth>; API: <https://2fa.directory/api/>
- Apple password-manager-resources: <https://github.com/apple/password-manager-resources>
- Bitwarden `StaticStore.cs` and licence: <https://github.com/bitwarden/server>
- ente custom icons: <https://github.com/ente-io/ente/blob/main/mobile/apps/auth/assets/custom-icons/_data/custom-icons.json>
- Aegis icons: <https://github.com/aegis-icons/aegis-icons>
- Public suffix list: <https://github.com/publicsuffix/list>

Licences:

- CC compatible licences: <https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses/>
- ODbL summary: <https://opendatacommons.org/licenses/odbl/summary/>
- GNU licence FAQ (read through a mirror; gnu.org returned HTTP 429): <https://www.gnu.org/licenses/gpl-faq.html>
