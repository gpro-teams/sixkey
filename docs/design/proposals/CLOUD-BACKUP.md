# Sixkey one-click cloud backup: design proposal (CLOUDBK)

> **2026-11-02, superseded in part: the Google half moved into an official plugin** (the owner: "把云备份功能做成官方插件吧";
> commit 42903a1 and its follow-up, [CLOUD-PLUGIN-NOTES.md](../notes/CLOUD-PLUGIN-NOTES.md)). The store build of Sixkey no
> longer has `identity`, an `oauth2` key or Google's origins in its CSP, as the status below and §2.5 still say: those
> are the separate **Sixkey Cloud Backup** extension's (`extension/plugins/official/cloud-backup/`), which has `identity`
> as a required permission and, as §2.5 measured, no host permission. What still holds as written: the file, its
> encryption and what opens it (§1), the write and cleanup rules (§3), the account pin (§2.1), the status (§6). The one
> click (§0.1) holds with the plugin installed: "备份到 Google 云端硬盘" approves the plugin in Sixkey and connects, the
> plugin's window signs in by itself and closes by itself, then Google's consent. Without the plugin, that click opens
> its Chrome Web Store page first (Chrome's own "Add" and its dialog), and Sixkey carries on by itself once it is added.
> The click counts as they are now: CLOUD-PLUGIN-NOTES.md §2.6.

> **Status: approved direction; patches 1–2 built, reviewed independently twice and revised (r3); patch 3 built and
> reviewed (P3-r2); patch 4 built (the worker) and reviewed; patches 5 and 6 built (the settings pages, the popup).** The owner answered the four questions of §9 on 2026-10-31 (OWNER-DECISIONS/21), each with the
> recommended option. Patches 1 to 4 of §8 are built and tested ([CLOUDBK-NOTES.md](../notes/CLOUDBK-NOTES.md)): the
> file format, the write rule, the status, restore's merge, the Drive client with a fake Drive, the Google sign-in and
> the network transport, the dev build's developer cloud page for §7.2, the settings pages (patch 5: Settings › Backup's
> card in every state of §6.2, the restore from Google Drive in first run and Backup, first run's offer, "选择文件" opening
> a cloud backup; the review of patch 4's A1 to A7; the wording of §6.3 as the maintainers settled it, in CLOUDBK-NOTES
> §7; patch 6: the popup's and the side panel's pill and footer, and the one click of the amendment below), and the
> service worker's backup (patch 4: when
> it runs, what it records, the account check, the store build's manifest and CSP, and the e2e build's in-extension
> fake Drive). An independent review of patches 1 and 2 (2026-10-31) found fourteen points
> (CB-01 to CB-14); the maintainers decided each, and r2 followed those decisions; a second review found five more
> (R2-01 to R2-05) and four in patch 3 (P3-01 to P3-04), which r3 and P3-r2 follow (CLOUDBK-NOTES §0 maps each to its
> change and test). The largest: the free backup
> keeps **only the latest copy** in Drive, and the duty to delete the rest is kept until it is done (§3.2, §3.3); a
> restore merges each vault on its own first (§3.6 step 4), lands on the newest vault key, keeps the password the user
> typed and never takes back a recovery key another computer replaced (§3.6 step 5); a backup is pinned to the Google
> account it was connected to (§2.1). Since patch 4 the store build's worker carries the backup, its manifest offers
> the optional `identity` permission and its CSP names Google's two API origins (§2.5); no page of it can turn the
> backup on yet (patch 5's card), and with no OAuth client named it has no `oauth2` key. The e2e build backs up to an
> in-extension fake Drive and names no Google origin; only the dev build has the developer page. A review of patch 3
> (r3 of patches 1–2) made six suggestions, S1 to S6, which patch 4 follows (CLOUDBK-NOTES §0). The design answers OWNER-DECISIONS/21 (2026-10-30): "备份页面怎么白嫖 Google 和 Apple 呢" and "一定一定备份要
> 简单……我希望的是一键点击就能备份……像这种形同虚设的备份交互我不希望出现". The file route's probe (§5) is a separate
> dev-only extension kept outside this repository; its automated half is recorded in §5.3, and the owner's run is
> pending.
>
> **2026-10-31, the maintainers' amendment to §0.1, §2.1 and §6.1:** the popup's "立即备份" is the one click. In that
> click Sixkey requests the optional `identity` permission and opens Settings › Backup with the card already connecting:
> the page starts `getAuthToken({interactive: true})` as it loads, with no click of its own (that this needs no user
> gesture is a 10-minute check item, §7.2 step 1). There is no second click on the card. The cost sentence stays on the
> card the whole time; it informs and never gates. The card's own button does the same for someone who starts from
> Settings.

Date: 2026-10-30; approved 2026-10-31. Author: design study (Opus 5.5) for the maintainers. Repository state read: `main`
at `2e260d0`.

**Markers**, as in `QUICK-UNLOCK.md`: **[verified]** I read the primary source (this repository's code or docs, an official
Google, Chrome, Microsoft or Apple page, or the Chromium source on GitHub `main`, which is not necessarily the stable
binary) or I measured it; **[transcribed]** taken from a secondary source, another document of this repository, or a vendor
page I fetched but did not test (vendor claims stay vendor claims); **[inferred]** my reasoning; **[estimate]** a number
nobody measured; **[unverified]** a claim I could not check. Every [unverified] claim is collected in §11.

---

## 0. Summary (read this first)

### 0.1 What the owner clicks

**First time, on the computer that has the accounts (Chrome).**

| # | Where | What the owner does | Why it cannot be removed |
|---|---|---|---|
| 1 | The popup's footer "N 个账户 · **立即备份**"; or, starting from Settings › Backup, the first card's **备份到 Google 云端硬盘**; or the last screen of first run | **One click.** In it Sixkey requests `identity` and opens Settings › Backup with the card already connecting (the amendment above); the card's own button does the same | The one click. The card shows the cost in one line the whole time; it informs and never gates (§1.5) |
| 2 | Google's own window (opened by Chrome) | Choose the Google account, **only if Chrome knows several**; click **允许** | Google's consent screen; no Google API can be used without it [verified: Chrome identity docs] |
| — | The card (already open, already connecting) | Nothing. It shows "已备份到 Google 云端硬盘 · 刚刚" within seconds | |

There is no type to choose, no export button, no list of backups to manage, no token to revoke, no backup password, no
file name, no folder. `identity` is an optional permission with no warning, so Chrome grants it inside click 1 without a
dialog of its own [verified: Chrome permissions docs, "Chrome prompts the user if adding the permissions results in
different warning messages"; `identity` has none].

**Every time after.** Nothing. 30 seconds after the last change (an account added, renamed, deleted, imported, a
password change), the service worker uploads the encrypted vault as it is on disk; it needs no unlock, so it also works
while Sixkey is locked, in "lock every time" mode, and after a browser restart (§1.2, §2.1). The status is always there:
"已备份到 Google 云端硬盘 · 3 分钟前" on the card, and in the popup the header pill turns from "本机" into "已备份". Sixkey
speaks up only when something is wrong: a failure, a lapsed Google grant, a full Drive, a backup older than 3 days with
changes waiting (§6).

**On a new computer.**

| # | Where | What the owner does |
|---|---|---|
| 1 | First run in the settings tab (the popup's welcome screen links there, as its restore link does today): **从 Google 云端硬盘恢复** | One click (in the tab, which stays open while Google's window has the focus; a popup would close) |
| 2 | Google's window | **允许** (and the account, if several) |
| 3 | Sixkey: "找到 Google 云端硬盘里的备份（3 分钟前）" | Type the **master password**, press Enter |
| — | | "已恢复 12 个账户"; this computer then keeps backing up to the same file |

**Edge and Brave** get the same clicks through `launchWebAuthFlow`. "Automatic" there means: as long as the browser still
holds the user's Google sign-in; otherwise the popup says "需要重新连接 Google 云端硬盘" and one click reconnects (§2.2).

**iCloud Drive, OneDrive, Dropbox.** "自动备份到你选的文件": one click, the system save dialog, pick a file in iCloud Drive.
Chrome does not block iCloud Drive or the `~/Library/CloudStorage` folders [verified: Chromium `main`]. Whether the
writes can continue after a browser restart without a click is exactly what the probe measures; the automated half
already shows that, by default, they cannot once every Sixkey page is closed (§5). It ships only if the probe shows it
can be near one-click (§5.6).

### 0.2 Recommendation in one table

| Topic | Recommendation |
|---|---|
| What is uploaded | **The encrypted vault exactly as it is on disk** (the active generation: envelope and keyring), never the PIN, Touch ID or plugin records. No unlock and no new password are needed, so the service worker uploads it by itself (§1, option a) |
| What opens it | **The master password or the recovery key**, as on this computer. One switch in the card, "只用恢复密钥打开", removes the password wrap from the uploaded copy (option c), best chosen before the first upload: a copy someone already downloaded stays as it was (§1.5). Decided: the owner's answer 1 (§9) |
| The honest cost | **Whoever controls the Google account can guess the master password offline**, at 2,000,000 PBKDF2-SHA256 iterations: for a memorable password of about 34 bits, about $210 of rented GPU time; 40 bits about $14,000; 50 bits about $14 million [estimate, from the study's measured GPU rate]. If the same Google account holds the sites' passwords (Google Password Manager), that is both factors behind one account. Option c removes it from what is uploaded from then on (128-bit key: not attackable) at the price of typing the recovery key on a new computer |
| Google scope | **`drive.file`**: a visible file the user can see, download and delete, and Sixkey can see nothing else of their Drive. Non-sensitive: no verification review, no unverified-app screen, no 100-user cap [verified] |
| Where | My Drive › **Sixkey** › **Sixkey 备份.json**, **the latest copy only**: after each upload Sixkey deletes the file's older revisions, which Drive would keep for 30 days, and after a change of secret its own earlier files; never another device's file (§3.2, §3.3) |
| Two devices | **A device overwrites only the revision it wrote itself**; anything else forks a new file. Restore opens every backup the password opens and **merges** them, so nothing is lost and nobody chooses (§3.3, §3.6) |
| The network | Only the service worker, as today; `connect-src` gains `https://www.googleapis.com` and `https://oauth2.googleapis.com`; **no host permission** (Google's API answers the extension's CORS request [verified: preflight, 2026-10-30]) |
| Text budget | New text in two lazy catalogs (`cloud` for the settings page, `cloud-popup` for the popup and side panel); the settings page's every-lazy-catalog view has 190 B left [verified: measured], so `cloud` needs its own view rule (§6.5) |
| Cost | About 16 to 20 team-days in 8 reviewable patches, plus review rounds [estimate] (§8) |

### 0.3 Verified, and not

- **Verified:** the vault on disk opens with the master password (PBKDF2, 2M) or the recovery key (HKDF) and needs no key
  to read (repository); `drive.file` and `drive.appdata` are non-sensitive (Google's Drive scope page); non-sensitive-only
  apps need no verification but brand verification to show a name and logo (Google Cloud help); Edge has no
  `getAuthToken` and supports `launchWebAuthFlow` (Microsoft's Edge API page); `launchWebAuthFlow`'s non-interactive
  options exist since Chrome 113 (Chrome docs); Drive keeps blob revisions about 30 days or 100 revisions and the API
  downloads only "Keep Forever" ones, `revisions.delete` deletes one for good and never the last one, `files.delete` skips the
  trash (Drive docs and reference); Drive's API and Google's revoke endpoint answer CORS for a
  `chrome-extension://` origin (curl preflight); Chromium blocks `~/Library` but not `~/Library/Mobile Documents`,
  `.../com~apple~CloudDocs` or `~/Library/CloudStorage` (Chromium `main`, commit `08da776`, 2026-10-29); Chromium grants
  a file permission request from an extension popup in a click without a prompt (commit `ecb83649e5`, 2025-10-10);
  in Chrome for Testing 156 a service worker can write through a handle a page stored in IndexedDB when the grant
  exists, gets `NotAllowedError` when it does not, and loses even a read grant once every page of the extension is closed
  or the browser restarts (the probe's automated run); the budgets (a build of `2e260d0`).
- **Unverified, checked by the probe (owner, 5 minutes):** whether "Allow on every visit" is offered to, and persists for,
  a `chrome-extension://` origin; whether the popup's silent re-grant lets the worker keep writing after the popup closes;
  whether the iCloud Drive save works in the owner's Chrome.
- **Unverified, checked in 10 minutes once the OAuth clients exist (§7.2):** that `getAuthToken({interactive: false})`
  returns a token after a restart with no UI; that interactive auth can run from the service worker; that a file created
  through the Chrome client is listed through the web client of the same project (backup in Chrome, restore in Edge);
  `launchWebAuthFlow` with Google in Edge, silent refresh with `prompt=none`; that `revisions.delete` and `files.delete` work under
  `drive.file` on the app's own file (the reference lists the scope).

---

## 1. What is uploaded, and what opens it

### 1.1 What exists today

- **The backup file** (`src/core/backup/backup.ts`, Settings › Backup › 加密备份) [verified]: `{format: "sixkey-backup", v: 1,
  created, app, kdf, iv, ciphertext}`. The plaintext vault is encrypted under a key derived from **a password typed for this
  file** (PBKDF2-SHA256, `PBKDF2_DEFAULT_ITERATIONS` = 600,000), with no link to the device key or keyring. Making one
  needs the vault plaintext, so it needs the vault unlocked, the master password typed again (H3: "every export asks for
  the master password again", `Backup.tsx`) and the file password typed twice and judged strong (`strong()` requires the
  page's strength check). It is a manual export by design.
- **The vault on disk** (`src/core/storage/format.ts`, `store.ts`, `crypto/keyring.ts`, `crypto/envelope.ts`) [verified]: the
  active slot holds one `Generation` = `{v, seq, savedAt, envelope, keyring}`.
  - `envelope` is AES-256-GCM under a key derived from the vault key (VK), with vault ID, VK ID and revision in the
    additional data, and a checksum that can be checked with no key (`isEnvelopeIntact`).
  - `keyring` holds the VK wrapped by the **master password** (PBKDF2-SHA256, 2,000,000 iterations for a wrap made now,
    at least 600,000 for an older one: `PBKDF2_PASSWORD_WRAP_ITERATIONS`, OWNER-DECISIONS/15) and by the **recovery key**
    (128 random bits, HKDF), plus earlier VKs wrapped by the current one. A Phase 0 device-key vault would hold a
    `device` wrap and the `deviceKey` itself; since C16 no account can be added without a master password.
  - `store.load()` returns the active generation **without any key** ("Nothing here needs a key", `store.ts`).
  - The PIN's record (`sk_pin_restart`), Touch ID / Windows Hello (`sk_prf`) and plugin approvals (`sk_plugins`) are separate
    keys, outside the generation.
- **The service worker keeps nothing in memory between events** (ARCHITECTURE §2.2, `sw.ts`) [verified], and in "lock every
  time" mode the VK lives only in the memory of the page that unlocked it (ARCHITECTURE §2.3) [verified]. So the worker
  cannot count on the VK: anything automatic must work without it.

### 1.2 The options

**(a) The vault as it is on disk.** The worker reads the active generation with `store.load()`, wraps it in a small
container and uploads it. No unlock, no VK, no new password. Opened by the master password or the recovery key, exactly
like this computer's own copy.

```json
{
  "format": "sixkey-cloud-backup", "v": 1, "app": "Sixkey 0.2.0", "opens": "both",
  "generation": {
    "v": 1, "seq": 41, "savedAt": 1793379341960, "envelope": { "...": "..." },
    "keyring": { "format": "sixkey-keyring", "v": 1, "vaultId": "...", "vkId": "...", "wraps": ["..."], "previous": [] }
  }
}
```

Rules, each with a unit test:

- **Never a device key.** A keyring with a `device` wrap or a `deviceKey` is never uploaded (it opens with no secret);
  the state says "设主密码后才能备份" [inferred: cannot happen after C16, but the rule is cheap].
- **Only the generation.** Nothing outside it is read: not `sk_pin_restart` (a 4-digit PIN at 2.6M iterations falls in
  seconds offline), not `sk_prf`, not plugin grants, settings, the security record or the diagnostics log.
- **No earlier vault keys.** The keyring's `previous` (the earlier VKs the current one wraps) is uploaded empty, and the
  parser refuses a file whose `previous` is not (review r2 CB-13). A restore never needs them: the envelope is always
  under the current VK (`checkGeneration`). Uploaded, they would hand whoever opens the file the keys to older copies
  that their own wraps no longer open. The one cost: a restore over this same computer's store cannot read its local
  snapshots made under an older VK, which the restored vault does not need [inferred].
- **Integrity before upload and before restore** with `checkGeneration` (shape, checksum, key/data agreement, no key).
  The parser refuses PBKDF2 counts outside 600k to 20M (`PBKDF2_MIN_ITERATIONS`, `PBKDF2_MAX_ITERATIONS`) before
  anything is derived, and one restore spends at most 40M iterations in all (`MAX_RESTORE_ITERATIONS`, twenty
  derivations at today's count); a file past that is skipped and named, so a planted file cannot make a restore derive
  for long (review r2 CB-09) [verified: the code].

**(b) The existing backup-password file, made automatic.** A file password cannot be applied by the worker: the file is
the plaintext re-encrypted under it, so every upload would need the VK **and** that password. The only automatic form
is (b′): the user types a backup password once, Sixkey wraps the VK under it, keeps that wrap, and uploads the envelope
with a keyring holding only that wrap and the recovery wrap. After every VK change (master password turned on, key
replaced: `rekey`) the wrap no longer fits and the backup stops until the backup password is typed again. On a new
computer it is a second password to remember. This is the Tampermonkey failure the owner described, in another form
[inferred].

**(c) Recovery key only.** The worker removes the password wrap from the uploaded keyring (a filter on `wraps`, no key
needed). Opened only by the recovery key (28 characters, or 2 of the 3 shares). After a restore Sixkey asks for a master
password, as the reset flow does today. No new secret, and nothing guessable is in what is uploaded from then on. Sixkey
deletes its own earlier copies at the next upload (§3.2, §3.3), but a copy someone already downloaded keeps the password
wrap; only a new vault key ("更换加密密钥") cuts such a copy off from what is uploaded after it. So the switch is best
chosen before the first upload, and the card says so (§1.5, §6.3).

### 1.3 What whoever controls the Google account can do

"Controls the Google account" means: Google itself (an insider, a legal order), and anyone who takes the account over
(phishing, a stolen session cookie, a recovery-flow attack, a family member who knows the password). Most of them have
no access to the computer, which is the point: a copy of the Chrome profile (attacker A3) already gives the same
material as option (a).

| | (a) as on disk | (b′) backup password | (c) recovery key only |
|---|---|---|---|
| What is in the file | VK under the master password (PBKDF2 2M; 600k for a wrap made before OWNER-DECISIONS/15) and under the recovery key | VK under the backup password and the recovery key | VK under the recovery key only |
| Offline guessing | **The master password**, at 2M | The backup password, at the count chosen (≥ 600k), and the page's strength rule makes it ≥ 50 bits | **Nothing to guess**: 128 bits behind HKDF |
| Expected cost, one RTX 5090 at $0.50/h [estimate] | 30 bits ≈ $13; 34 bits ≈ $210; 40 bits ≈ $14,000; 50 bits ≈ $14M; 5 EFF words ≈ $3.5 × 10¹¹ | 50 bits at 600k ≈ $4.2M | ≈ $10²⁵ |
| Delete or roll back the backup | yes | yes | yes |
| Plant a file that a restore accepts | nothing new: a file must open with the user's own secret (AES-GCM unwrap, AAD-bound). The user's own files can be put back: an older version or another fork re-uploaded as new is accepted and merged (harmless for the accounts), and a client can set `modifiedTime`, so it can become the newest file; a restore takes the vault key and the recovery wrap by `createdAt`, which is not authenticated either, so someone holding a retired secret could re-date its wrap; a password restore still keeps the password typed (§3.6 step 5) | same | same |
| What Google learns | that the account uses Sixkey, the file's size (about the number of accounts), when it changes (when the user edits accounts) | same | same |

The cost line is computed from RECOVERY-SECRET-AND-CHROME-SYNC-STUDY §1.2 [transcribed there as verified from a published
hashcat benchmark]: about 5,600 guesses a second per RTX 5090 at 2M iterations, expected cost at half the space. A
memorable password of about 34 bits at 2M is about 430 GPU-hours: four hours on 100 rented GPUs [estimate].

**The two-factor point.** Sixkey's codes are the second factor. If the user's site passwords are in Google Password
Manager, an attacker who takes over the Google account can read them after Google's re-authentication, and under (a)
also buy the codes for the price above. Today, without a cloud copy, that attacker gets the passwords but not the codes
[inferred]. For a user with a strong master password this is moot; for a memorable one it is the real cost.

**D2 and OWNER-DECISIONS/15.** SYNC-DESIGN's D2 keeps the guessable wrap from an attacker who has only the e-mail account;
the study already noted that Google-held ciphertext "bypasses D2" (§2.7 there) [verified]. OWNER-DECISIONS/15 made a
device-held account key a precondition before Sixkey's own sync goes live, "否则服务器数据库一旦泄露，就等于给人一个离线猜你密码
的机会" [verified]. Option (a) is the same exposure with two differences [inferred]: there is no one database of every
Sixkey user (each copy sits in its owner's Google account, so the attack is targeted, not mass; Google itself excepted),
and the owner opts in per account by clicking. It does not trigger the account-key precondition, but it is the reason to
state the cost on the card.

### 1.4 Rejected strengthenings

- **A higher iteration count for the cloud copy only** (re-wrap the VK at the code's maximum, 20M, used only at restore):
  +3.3 bits (a password of about 34 bits: $210 → $2,100), and it needs the VK and the typed password together, which only a master-password
  unlock has; the PIN unlock does not. Not worth a second wrap and a 5 to 30 second restore [estimate].
- **A secret kept elsewhere at Google** (`chrome.storage.sync`, `drive.appdata`): the same account controls it; useless.
- **A synced passkey with PRF in iCloud Keychain** as a second provider (QUICK-UNLOCK's synced option): would make the
  Google file useless without the Apple account and restore with Touch ID. A good later stage; PRF from an extension
  page with iCloud Keychain in Chrome is unmeasured here [unverified].

### 1.5 Recommendation

**Option (a), with option (c) one switch away, and the cost stated on the card, always, in one line.** It is the only
option that keeps both of the owner's flows: one click to back up, and a new computer restored with the password typed
every day. (b′) adds a second password and a stop after every key change. (c) is the safer default for a user whose
site passwords are in the same Google account, and it costs nothing at backup time; it costs a 28-character key on a new
computer, and a lost recovery key then means a lost backup, which is the "形同虚设" outcome the owner fears most.
"Warn, never block": the card says it, the switch is there, nothing is refused.

**What a change reaches** (review r2 CB-01). The free backup keeps only the latest copy (the owner's answer 2 puts history
in the paid cloud). After every upload Sixkey deletes the file's older revisions (§3.2); after a password change, a reset,
a new recovery key, a new vault key, the switch to option c, or an account erased for good, it also deletes the earlier
files its own forks left (§3.3). It never deletes another device's file: with sync on, that device receives the new
keyring and prunes its own; with sync off, that device's file is its own vault's state. What none of this reaches is a
copy someone already downloaded: it keeps the wraps it had; nor a file the user put in Drive's trash, which keeps its
original wraps until Drive empties the trash, for up to 30 days [transcribed].
Said plainly: option c, or a new master password, protects what is uploaded from then on, and "更换加密密钥" (a new vault
key) is what makes an old copy useless for everything after it. With sync off, a new vault key reaches only the computer
that made it: another computer keeps uploading under the old key until it too replaces it; a restore still lands on the
newest key, and says that another backup is under an older one (§3.6 step 5). Hence the switch's hint on the card:
choose it before the first upload.

The card's line (§6.3): "能用主密码或恢复密钥打开。能进入你 Google 账户的人可以试着猜主密码，主密码越难猜越安全。"

---

## 2. Google sign-in and the network

### 2.1 Chrome: `chrome.identity.getAuthToken`

- **Manifest** [verified: Chrome OAuth docs]: `"oauth2": {"client_id": "<id>.apps.googleusercontent.com", "scopes":
  ["https://www.googleapis.com/auth/drive.file"]}` and `identity` in `optional_permissions`. The client is of type
  **Chrome Extension** with the extension ID as its Item ID, so it is tied to that ID: one client for the store ID (which
  does not exist until the first submission, OWNER-DECISIONS/11), one for the dev build's fixed ID
  `pgnlbjikdnniepfeijffpefifnojjege` (the public key in `manifest.dev.json`; `check-dist.mjs` `DEV_EXTENSION_ID`)
  [verified]. The e2e build has no client and uses a fake (§8).
- **Account**: "the Sync account if there is one, or otherwise the first Google web account" [verified: identity docs].
  The card names the account it backs up to (from Drive's `about.get`, which needs no `identity.email` permission and so
  no "Know your email address" warning) [verified: `about.get` accepts `drive.file` and requires `fields`]. The address
  can be missing: Drive's User resource says `emailAddress` "may not be present in certain contexts if the user has not
  made their email address visible to the requester" [verified: Drive v3 User resource, 2026-10-31] (review r3, S5).
  The pin then holds the id alone (`email: null`), the card says "已连接 Google 云端硬盘" without an address, and the
  silent renewal goes without `login_hint`; nothing else changes. "换一个 Google 账户" uses the
  web flow of §2.2 with `prompt=select_account`, in Chrome too.
- **The account pin** (review r3, P3-01). At connect, the account is recorded: Drive's `about.get` for
  `user(emailAddress,permissionId)` (`pinAccount`), in `sk_cloud_cfg.account`. `permissionId` is Drive's own id for the
  account, "The user's ID as visible in Permission resources" [verified: Drive v3 User resource]; that it does not
  change when the address does is [inferred] (the page promises no stability; review r3, S5). `about.get` needs no scope
  beyond `drive.file`, where Google's
  tokeninfo would need the token in a URL and userinfo the `openid`/`email` scopes, a second consent line. Before every
  upload the worker asks `about.get` again (`runBackup`'s `account`); a token of another account (a browser signed in to
  several, a primary account switched, a shared profile) writes nothing: the status is "需要重新连接 Google 云端硬盘". The
  web path's silent renewal names the recorded address as `login_hint` (§2.2). Patch 3 has the logic, its tests and the
  fake; patch 4 records the pin at connect (`cloud-worker.ts` `connected`: the page signs in, then tells the worker,
  which asks `about.get` itself) and passes it to every run.
- **Another account: two ways, never a silent switch** (review r3, S5). In Chrome, `getAuthToken` gives only the
  browser's own Google account, so after a switch of that account a plain "重新连接" would fail for ever. The worker keeps
  the account the token was for as `sk_cloud_cfg.mismatch` and changes nothing else; a connect with another account
  than the recorded one is refused the same way. Patch 5's card offers exactly two ways:
  1. **Reconnect the recorded account**: the web flow (§2.2) with `prompt=select_account` and the recorded address as
     `login_hint`, in Chrome too; the worker is told `via: "web"` and uses the web path's tokens from then on. Words:
     "连接的是另一个 Google 账户（$1）。备份仍属于 $2 · 重新连接 $2".
  2. **Move the backup to the new account** (`switchAccount`): that account is recorded, the link is dropped, so the next
     upload makes a new file in its Drive; the files in the old account stay there. Words: "改为备份到 $1 · 以后的备份存到
     这个账户，原账户里的文件不会删除".
  Neither happens without the user's click; the worker never records another account on its own.
- **Tokens**: Chrome caches them in memory and "the token cache automatically handles expiration" [verified]. With
  `interactive: false` it "will return failure any time a prompt would be required" [verified], which is what the worker
  calls before every upload: no UI, ever, from the background. A 401 → `removeCachedAuthToken` (Chrome 106+) → one retry →
  otherwise "需要重新连接". So in Chrome, **automatic means automatic**, across restarts, as long as the grant stands and
  the profile keeps that Google account [inferred from the docs; the restart case is a 10-minute check item].
- **Consent**: `enableGranularPermissions` left off: one scope, one "允许" [inferred].
- **From where** (the amendment): the click is in a page, the popup or the card, which calls `chrome.permissions.request`
  inside it (that needs a user gesture [verified]). The popup then opens Settings › Backup, and the settings page starts
  the interactive `getAuthToken` as it loads, with no click of its own [unverified: §7.2 step 1]; the tab stays open while
  Google's window has the focus, where a popup would close. The page then asks the worker to upload. Whether the worker
  itself could run the interactive call is [unverified] and not needed.

### 2.2 Edge, Brave and others: `launchWebAuthFlow`

- Edge: "Not supported: identity.getAccounts, identity.getAuthToken - As an alternate, you can use
  identity.launchWebAuthFlow" [verified: Microsoft Learn, Edge API support]. Brave has no Google account in the browser;
  `getAuthToken` is assumed to fail [unverified]. Detection is by trying `getAuthToken` and falling back.
- **Flow**: a Google OAuth client of type **Web application**, redirect `https://<extension-id>.chromiumapp.org/`
  (`getRedirectURL()`) [verified]; `response_type=token`, `scope=drive.file`, `include_granted_scopes=true`, a random
  `state` checked on return, `login_hint` for the silent renewal once the account is pinned (§2.1). Google returns an
  access token with `expires_in`
  (3600 in Google's example) and no refresh token [verified: Google implicit-flow page]. Google calls the implicit flow
  "considered insecure for browser-based single-page applications" and recommends code + PKCE [verified]; a web client's
  code exchange needs a client secret, which an open-source extension cannot keep [unverified that Google requires it
  with PKCE], so there is no refresh token without a server.
- **Silent refresh**: `launchWebAuthFlow({interactive: false, abortOnLoadForNonInteractive: false,
  timeoutMsForNonInteractive: 10000})` with `prompt=none` (Chrome 113+) [verified: identity docs]; it can only succeed
  while the browser holds the user's Google sign-in cookies [inferred]. The token is kept in `chrome.storage.session`
  (memory only, trusted contexts only; ARCHITECTURE §4) with its expiry, so a restart drops it and the worker refreshes
  silently.
- **What "automatic" means there**: automatic while the user stays signed in to Google in that browser; after a sign-out,
  cookie clearing or Google's session ending, one click ("重新连接") and maybe Google's sign-in. The status line says so;
  the backup never fails silently.
- **Edge store ID**: the Edge Add-ons store gives its own extension ID [transcribed], so its redirect URI is registered
  beside Chrome's on the same web client.

### 2.3 The `identity` permission

- Optional, requested in the click that turns backup on, removed when it is turned off (the pattern of `scripting` and
  `management` here) [verified: ARCHITECTURE §4].
- `identity` has no warning; `identity.email` would ("Know your email address") and is not used [verified: permissions
  list]. Chrome prompts only when warnings change, and an update that adds an optional permission does not disable the
  extension [verified: permissions API docs]. So: no install warning, no update warning, no dialog at the click.
- The `oauth2` key itself shows nothing [inferred].

### 2.4 Scope, verification and policies

- **`drive.file`** vs **`drive.appdata`**: both non-sensitive ("recommended for most use cases") [verified]. `drive.file`
  lets the app create files and use only the files it created or the user opened with it; `drive.appdata` is a hidden
  per-app folder the user cannot browse or download from, only delete as a whole [verified for the scope text; the UI
  detail transcribed]. The owner asked for "你云端硬盘里一个看得见的文件……你可以自己下载、换一份 Sixkey 打开"
  (OWNER-DECISIONS/21 item 4): **`drive.file`**. It is also the visible "presence" the owner wants, and Google's page itself
  recommends it ("Whenever possible, use non-sensitive scopes as they grant per-file access") [verified]. Its one cost: a
  copy the user uploads by hand is invisible to Sixkey (restore then uses "选择文件", §3.6).
- **Verification**: an app with only non-sensitive scopes does not have to go through app verification; to show its name
  and logo on the consent screen it needs brand verification (a homepage on a verified domain, a privacy policy on the
  same domain linked from both, Search Console domain ownership) [verified: Google Cloud help 13463073, 13464321]. The
  unverified-app screen and its 100-user cap apply to sensitive and restricted scopes [verified: help 7454865].
- **Publishing status**: an external app in "Testing" gets tokens that expire after 7 days [verified: Google OAuth 2.0
  page]; the app must be "In production" before release (owner task).
- **Google API Services User Data Policy**: request only the scopes needed; publish a privacy policy that documents how
  the app uses Google user data; Limited Use is spelled out for sensitive and restricted scopes [verified; its exact reach
  for non-sensitive scopes transcribed]. Sixkey reads only its own file, keeps nothing on any server, and sends Google
  data nowhere [inferred].
- **Chrome Web Store** [verified: Limited Use and user-data FAQ]: "accesses ... files, or other data from a user's cloud
  service" is handling user data: here the encrypted vault, which holds the secrets. `identity` is used only to back up
  that vault to the user's own Google Drive, when the user turns backup on. Limited Use compliance is to be stated on
  the website.

### 2.5 The network rules

Today only the worker reaches the network and only the sync API's origin (ARCHITECTURE §4; `check-dist.mjs`) [verified].
The change keeps the shape:

- **CSP** (manifest): `connect-src https://api.sixkey.app https://www.googleapis.com https://oauth2.googleapis.com`; every
  page keeps its own `connect-src 'none'`, so still only the worker can fetch.
- **No host permission.** A preflight from `Origin: chrome-extension://…` to `www.googleapis.com/upload/drive/v3/files`
  returns `access-control-allow-origin` echoing that origin and allows `authorization, content-type`; the 401 of
  `drive/v3/about` carries it too; `oauth2.googleapis.com/revoke` likewise [verified: curl, 2026-10-30]. No permission, no
  warning.
- **A second transport**, `src/platform/google-transport.ts` (built in patch 3, where only the dev build's worker uses
  it, for §7.2's page; patch 4 wires it into the store build with the rules below; the Drive client of patch 2 takes any
  transport), under the rules of `fetch-transport.ts`: fixed origins and path prefixes (`/drive/v3/`,
  `/upload/drive/v3/`, `/revoke`), `credentials: "omit"`, no cache, no redirects, `Accept-Language: *`, a 60 s limit, a
  9 MiB response cap, errors that carry no URL, header or body. The source rule that `fetch` is used in one module only
  (`test/unit/m5-source-rules.test.ts`) changed with it, to name the two. Within Drive's roots, only the endpoints the
  backup calls, each with its one method (review r3, R2-05: `ENDPOINTS`): about; files' list, get, create and delete; a
  file's revisions, listed and deleted; the two uploads. Not `files/trash`, a file's permissions or anything else.
- **`check-dist.mjs`**: `EXPECTED_CSP` updated; `fetch` exactly twice in `sw.js` (the two transports); `URL_ALLOWED` gains
  the two Google origins' exact prefixes, the scope name, Google's auth URL (opened by `launchWebAuthFlow`, never fetched)
  and `https://drive.google.com/drive/folders/` (opened in a tab); the expected manifest gains `oauth2` (per flavour) and
  `identity`; the e2e build must carry the fake and no Google client.
- **The switch**: the worker checks `chrome.permissions.contains({permissions: ["identity"]})` before every token it
  asks for (`google-auth.ts` `ready`; the sign-in is built per run, since `chrome.identity` appears only once the
  permission is granted) and the backup setting before every run (`cloud-worker.ts`), as it checks the API host
  permission for sync today (`api-permission.ts`).
- **Built in patch 4**: the CSP and `identity` above in the store and dev builds; `URL_ALLOWED` there gains exactly
  `GOOGLE_URLS` (Drive's origin and its two roots, the revocation URL, the scope name, Google's auth URL); `fetch` twice
  in their `sw.js`, once in the e2e one's; the e2e build has the fake's mark in its worker and no Google origin,
  `identity` or `sk_cloud_token` in any file, and a Google build none of the fake. `https://drive.google.com/drive/folders/`
  waits for patch 5's card, which opens it. The worker's size is held: 112 KB gz (§6.4).
- **Built in patch 5** (the review of patch 4): the CSP names paths, not origins (A2: Drive's `drive/v3/` and
  `upload/drive/v3/`, and `oauth2.googleapis.com/revoke`), so the browser itself holds the worker to them; Google's window
  is `google-connect.ts`'s, imported by the settings page alone, and check-dist finds no interactive call in any build's
  `sw.js` (A4); the worker's budget is 104 KB gz (A7); `https://drive.google.com/drive/folders/` is allowed as the card's
  link (opened in a tab, never fetched), exactly that prefix, in a build with Google.
- **Docs**: PRIVACY.md's headline ("Sixkey does not collect, send, or share anything. This version makes no network
  requests") and its "does not do" list must change; ARCHITECTURE §2.2 (worker row), §3 (new keys, §3.4 here), §4 (the
  network bullet), §7 (OAuth clients per flavour); `docs/security/local-vault.md` (the Google-held copy); the store's
  privacy tab. Draft wording is part of patch 8.

---

## 3. Drive mechanics

### 3.1 File and folder

- **My Drive › Sixkey › Sixkey 备份.json** (English UI: "Sixkey backup.json"), `mimeType: application/json`, a description
  ("Sixkey 的加密备份。用 Sixkey 和你的主密码或恢复密钥打开。"), and private `appProperties` `{sixkey: "backup", f: "1"}` by
  which restore finds it (`appProperties has { key='sixkey' and value='backup' } and trashed = false`) [verified: Drive
  search and properties pages; private properties are "restricted to your app", 124 bytes each].
- The folder is created by Sixkey (`drive.file` can) [inferred]; if the user moves the file, search still finds it.
- The name is fixed at creation in the UI language; it never carries a date.

### 3.2 Overwrite, and the latest copy only

- One file, updated in place (`PATCH /upload/drive/v3/files/{id}?uploadType=media`). Drive would keep purgeable revisions
  of a blob file "typically ... for 30 days", fewer if it has 100 and a new one arrives; "Keep Forever" revisions (up to
  200) count toward storage; the API downloads only Keep Forever revisions [verified: Drive revisions page]. Anyone in
  the Google account can download the others in Drive's "Manage versions" [transcribed].
- **The latest copy only** (review r2 CB-01; history is the paid cloud's, the owner's answer 2). Those revisions would keep
  what the device replaced or erased on purpose: the password wrap before a change or before option c, an account erased
  for good. So after every successful upload, new file or overwrite, Sixkey lists the file's revisions
  (`revisions.list`, `fields=revisions(id,modifiedTime,keepForever),nextPageToken`) and deletes every one **older than
  the revision it just wrote** with `revisions.delete`, which is permanent, with no trash, and cannot delete the last
  remaining revision [verified: revisions reference]. It never deletes a revision newer than its own (a racing writer's,
  the head now) or one the user marked Keep Forever. The list promises no order, so this goes by `modifiedTime`
  (`rules.ts` `revisionsToDelete`). The reference lists `drive.file` among the scopes for `revisions.delete` [verified];
  that it works on the app's own JSON file is a §7.2 check item.
- The duty is kept until it is done (review r3, R2-02). Every upload marks the link `pruneDue` and saves it before it
  deletes anything; the mark is cleared only once Drive lists nothing older (Keep Forever and later revisions aside).
  While it is set, every run deletes them first, also a run that has nothing to upload (the daily check included), so a
  503, a lost network or a worker stopped in the middle is made good by the next run, not by the next change. Sixkey's
  own history is the local store's snapshots; a restore reads heads only.

### 3.3 Two writers: the safe rule

The worker cannot decrypt, so it cannot merge or count accounts. The rule is about **lineage** instead (`rules.ts`
`decideWrite`, in this order):

1. **No file yet**: create one.
2. **After a local recovery, fork.** When the store falls back to the other slot, a snapshot or the mirror
   (`beforeRecoveryWrite`, the hook sync already uses), the cloud file may be newer than what this computer now has. The
   next upload forks, and the card says "本机的数据是从较早的副本恢复的，云端可能有更新的备份 · 从云端恢复".
3. **Another vault, another file.** A different `vaultId` (start over, a restore of another vault) never overwrites.
4. **Never backwards within a file.** A generation with a lower `seq` than this device last uploaded to that file forks.
5. **The file is gone or in the trash** (the user deleted it): a new file, with a notice.
6. **Nothing changed** since the last upload (the same save, vault key, wraps and `opens`): skip.
7. **Overwrite only the revision you wrote.** After every upload the worker stores the file's `headRevisionId`. Before
   the next, it reads the metadata; if the head is another, someone else wrote it (another computer restored from it, a
   cloned profile, the user replacing the file): **fork**, i.e. create "Sixkey 备份 (2).json" and continue there, with a
   one-time notice. Drive v3 returns no file etag, while v2 has one and refuses an `If-Match` update with 412
   `conditionNotMet` [transcribed: community reports, 2014–2026; unverified against today's API]; patch 2 does not use
   it (a second API version for one unverified call), and accepts the race: two writers of one lineage that read the
   same head within the same second both overwrite. The one overwritten forks only at its **next upload that has a
   change** (rule 7 comes after rule 6); until then its last upload is on its own disk only, since the other's upload
   deletes the older revisions (§3.2) and a restore reads heads only (review r2 CB-05) [inferred].
8. Otherwise **overwrite**.

**What Sixkey deletes: never another device's file; only the latest version of its own** (this replaces v1's "never
delete", review r2 CB-01):

- after every upload, the file's revisions older than the one it wrote (§3.2);
- at a **wrap or purge event**, also this device's own earlier files. The events: a password change, a reset, a new
  recovery key, a new vault key, the switch between both and recovery-only (`pruneEvent`: the uploaded wraps or `opens`
  differ from the last upload's), and an account erased for good (`purgeForever`: the caller says so, since the worker
  cannot see inside the vault). The own earlier files are the ones its forks of rules 2, 3 and 4 left behind, which it
  wrote and no other device continues (`CloudLink.own`). Each is deleted for good (`files.delete`, no trash [verified:
  files reference]) only when the page holding the vault key has merged it into what it uploads and it is still at the
  head this device wrote (`ownFilesToDelete`). One another writer continued since is no longer this device's and is never
  deleted; the page merges only files of the same vault, so a start-over's file of the old vault stays. The event marks
  the link `filesDue` (review r3, R2-02): when the worker meets the event alone (no page, no vault key), the earlier
  files wait, and the next run that a page holding the vault key makes merges and deletes them, whatever changed or did
  not change since; the mark is cleared only when every one it merged is gone.
- A file the user put in the trash is the user's: Sixkey does not touch it, and it keeps its original wraps until Drive
  empties the trash, for up to 30 days.
- A fork by rule 5 or 7 leaves nothing of its own behind: the file is gone, or another device continues it.
- With sync on, the other devices receive the new keyring and prune their own files. With sync off, each device's file
  is its own vault state, and it stays.
- Turning backup off runs the backup once more first, so what is owed is done if it can be (review r3, S3); then it
  leaves the file, and says so. The link stays for a later "on".
- **How the duties are kept** (review r3, S1–S3). Each earlier file in `own` records the vault it held (`vaultId`): an
  earlier file of this vault owes its deletion until a page merges it or another writer takes it, so a page's `merged:
  []` ("looked, merged none") lets go only of other vaults' files (a start-over's), never of this vault's. A page's
  `merged` list is bound to the generation it was merged into (`seq` and the envelope's `rev`): a run of another
  generation, or of a link the store's recovery marked, deletes nothing and keeps the duty, so a list that outlives a
  store fallback can never delete a file whose accounts the upload lacks. An overwrite saves a hash of the text it sends
  (`pending`) before sending: when the answer is lost, the next run downloads the head, and if it is that text, takes it
  as its own and does its cleanup, where it used to fork. A file left behind (a fork) while its revisions are still owed
  keeps that duty as an entry of `prunes` (at most 20), done by every run until it succeeds. What can still lose a duty:
  a link that no longer parses (taken as none), a restore in place (`adoptLink` starts a new link) and a backup turned
  off while Drive refuses; Drive's own clean-up of revisions, typically after 30 days, bounds the first; an orphaned
  earlier file stays until the user deletes it [inferred].

A rule "never overwrite with fewer accounts without asking" is not needed and could not be checked without the key:
rules 2 to 7 confine every overwrite to the device's own continuing history, and a deletion there is the user's own (and
the vault keeps deleted accounts in its trash and their tombstones) [inferred].

### 3.4 What is kept locally

| Area | Key | What |
|---|---|---|
| `storage.local` | `sk_cloud_cfg` | as built in patch 4 (`platform/cloud-config.ts`): `{v, on, via: "chrome" \| "web", opens: "both" \| "recovery" (the switch), account, link, merged, purged, mismatch}`. `account` the pin `{id, email}` (§2.1); `link` is `rules.ts`'s `CloudLink`, `{v, fileId, head, seq, vaultId, vkId, opens, wraps, own, recovered?, pruneDue?, filesDue?, prunes?, pending?}`: what was uploaded last, with `wraps` each wrap's method and IV (in the file anyway), `own` this device's earlier files `{id, head, vaultId}`, and the cleanup still owed (§3.2, §3.3); `merged` a page's list `{seq, rev, files}` (§3.3); `purged` an account erased for good since the last upload; `mismatch` the other account a token was for (§2.1). A record that does not parse is no record (backup off, no link); no secret. No `provider`, folder id or file name: the folder is found by its `appProperties`, the name is fixed when the file is made, and the file route (§5) would add its own |
| `storage.local` | `sk_cloud_state` | `{v, lastOk, err, errSince, pendingSince, retries, lastRun, paused, pruneFailingSince, folder}`: the status line's times (§6.2), the failures in a row (the next retry's delay), the last run's end (the daily check); since patch 5 whether `identity` was withdrawn (paused, review P4 A3), since when a clean-up keeps failing (A5), and the backups' folder's id (the card's link, found and never made); since patch 5's second round `unrevoked`, a "断开" that could not confirm the recorded account's grant withdrawn on the path in use, the mismatch state included (REVIEW-P5P6 R5-1; -r2 R2-2, B8; -r3 C2; -r4 D1: the card says so until a connect, or until the user says "我已移除", B7). Every run that goes through sets the existing `sk_last_backup`, so the popup's reminder counts the file in Drive |
| `storage.session` | `sk_cloud_go` | patch 5: the time of a click elsewhere (first run's offer, the popup's "立即备份") that asked for `identity` and wants the card to connect; the card takes it within 60 s, as it loads |
| `storage.session` | `sk_cloud_token` | the web flow's access token and expiry only (Chrome's tokens stay in Chrome's cache) |
| IndexedDB `sixkey-files` | `backup` | the file route's `FileSystemFileHandle` (§5) |

### 3.5 Quota, size, failures

- **Size**: the JSON of the envelope, base64: tens of KB for a typical vault, at most `MAX_ENVELOPE_BYTES` (8 MiB) by sync's
  rule [estimate; constant verified]. One multipart request takes "5 MB or less" [verified: Drive upload guide]; Sixkey
  does no resumable upload, so a larger file stops with "too_large" before sending (`MAX_UPLOAD_BYTES` = 5 MiB; should
  Google count 5 MB in decimal, its 413 maps to the same code) (review r2 CB-08, CB-11). A free account has 15 GB
  shared with Gmail and Photos [transcribed]. Whether purgeable revisions count toward quota [unverified]; at 100 × 100 KB
  it does not matter.
- **Rate**: an upload 30 s after the last change (`chrome.alarms`, one name, re-armed; the floor is now one second, and
  alarms persist across browser restarts by default from Chrome 150 [verified: alarms docs], so a pending upload survives
  a restart, and the worker's start checks anyway, as `ensureAlarms` does); retries at 1, 5, 30 minutes, then
  with the 6-hourly routine; a daily metadata check finds a deleted file or a revoked grant even without changes. Built
  in patch 4 (`cloud-worker.ts`): a change is a write of the store's pointer, from any context (the worker's
  `storage.local.onChanged`); an error no retry fixes (§6.2's stopping ones) arms no retry and waits for the user and
  the daily check; a deletion still owed after an upload that went through is retried with the same delays; a token
  Drive refuses (401) is dropped and the run tried once more; one run at a time, and a change during a run gets one more
  after it. The e2e build's debounce is 5 s. Since patch 5 (review P4, A6) changes that keep coming wait at most 5
  minutes after the first, unless failures wait for their own retries.
- **The user deletes the file** (404, or `trashed: true`): a new file at the next upload, notice "云端的备份文件不见了，已重新
  建了一个". Turning backup off is how to stop it, and the card says that.
- **The user revokes access** (Google Account › Security, or Google's time-limited grants expiring, which Google now offers
  [transcribed: OAuth 2.0 page lists "time-based access"]): 401 / `invalid_grant` → "需要重新连接 Google 云端硬盘 · 重新连接".
- **Drive full** (`storageQuotaExceeded`): "Google 云端硬盘空间已满，备份没成功"; nothing local changes.
- **Refused** (403 `domainPolicy`: a Workspace admin's policy; `appNotAuthorizedToFile` and other reasons of Drive's error
  page): it stops with "forbidden" until the user acts. Drive's rate limits (403 or 429 `rateLimitExceeded`,
  `userRateLimitExceeded`, `dailyLimitExceeded`, `sharingRateLimitExceeded`, or any reason of domain `usageLimits`) are
  retried [verified: Drive "Resolve errors" page] (review r2 CB-07). The full map from the Drive client's codes to the
  status is `remote.ts` `cloudErrorOf` (CB-08).

### 3.6 How restore finds the files and opens them

1. List: the query of §3.1, newest first, page after page (`nextPageToken`) up to 200 files; beyond that the result says
   how many were not read, and the page says so ("还有 N 份备份没有读取") (review r2 CB-04) [verified syntax]. Only files
   the app created are visible under `drive.file` [transcribed: scope description]. Whether a file created through the
   Chrome client is visible through the web client of the same Cloud project (backup in Chrome, restore in Edge)
   [unverified: 10-minute check].
2. Download each (small), `checkGeneration` each, drop the damaged or newer-format ones (named in a fold); the developer
   page's files carry `sixkey: "devcheck"` and are never listed (P3-03). Each keeps the
   head the listing returned, so a file rewritten since is forked from, never overwritten (step 6).
3. Ask the password once (or the recovery key). Derive once per distinct wrap (same salt, same derivation); a file whose
   own wrap does not fit but whose vault key is already in hand (a fork made before a password change) opens with that
   key (review r2 CB-06). At most 40M PBKDF2 iterations in all (§1.2); a few seconds on a Mac [estimate].
4. **Merge, vault by vault** (review r2 CB-02). The files of each vault with `mergeVaults` (commutative, idempotent;
   deletions win by their clocks, so within a vault an old file cannot resurrect a deleted account); the newest file's
   vault is the base, and each other vault, merged first, adds its live accounts as new entries, skipping those already
   there, trash included (`addAccountsFrom`, as `importBackup` does) [verified]. Every file is clamped first
   (`clampVault`). Two vaults share no clocks: an account deleted in one and alive in the other comes back as the other's,
   as an import does [inferred]. "已恢复 12 个账户（合并了 2 份备份）". Files the typed secret does not open are named:
   "还有 1 份备份用这个密码打不开 · 换一个密码试试".
5. **The key and the keyring** (review r2 CB-03; review r3 R2-03, R2-04). With sync off the computers' keyrings are
   separate, so neither "the newest file's key" nor "the newest file's keyring" will do.
   - **The vault key**: within the base vault, the newest one, the key whose keyrings hold the newest wrap by `createdAt`
     (a tie goes to the newer file), not the key of the file Drive changed last: a computer that did not take part in a
     rotation may well write last, and a restore must not land on the key the rotation retired. The files under the
     vault's other keys are opened and merged all the same; the restored device continues the newest file under the
     newest key; `olderKeys` says how many other keys there were, and the page says "另一份备份用的是旧的加密密钥；请在那台
     电脑上也更换加密密钥".
   - **The recovery wrap**: the newest by `createdAt` among the opened files under that key, so a password restore never
     brings back a recovery key another computer replaced.
   - **Master password**: one step, as before. The restored keyring keeps the password wrap the typed password opened
     (the newest such), never one the user did not type, so no clock, however wrong, can lock the user out of what was
     restored. When a password wrap dated later exists (changed on another computer, or a clock that ran ahead),
     `outdated` says so, and patch 5's page offers "设置新主密码" right there, with the vault key in hand: one field, and
     "以后再说"; warn, never block. Its words: "另一台电脑上的主密码比你输入的新。可以现在设一个新主密码，并在那台电脑上也改成它"
     (REVIEW-P5P6 B4). After a recovery-key restore (`needsPassword`), `outdated` means the recovery key was replaced
     on another computer: no form (a new master password was set a step before), one line instead (R5-2): "你输入的恢复
     密钥已在另一台电脑上换过，这台电脑以后也用新的那把".
   - **Recovery key**: the reset flow. The restored keyring keeps the recovery wrap only, and a new master password is
     set next (`needsPassword`); under option c this is the only way anyway.
   - `createdAt` is not authenticated and comes from each computer's clock: a clock far ahead, or someone who controls
     the Google account and holds a retired secret, can make an old wrap look new. A password restore is never locked
     out by it (above); a recovery wrap chosen that way is replaced when the user sets a new recovery key; and a person
     holding the retired secret already holds what it opened, for which a new vault key is the cure (§1.5) [inferred].
   Then this is written as this computer's vault; the PIN, Touch ID and the profile question come after, as in first run.
6. Adopt the newest file under the newest key as this computer's backup (rule 7 forks it if the old computer still
   writes there).

A copy the user downloaded and uploads by hand, or keeps on a USB stick, opens through Settings › Backup › 选择文件, which
learns the new format (§8, patch 5).

---

## 4. Sixkey sync, lock modes, profiles

- **Sync off**: as above.
- **Sync on**: every device has the same vault and keyring; each backs up its own lineage (rule 7 forks per device, named
  "Sixkey 备份 (2).json" and so on). Restore merges them all. A restored computer still needs D2 approval or the recovery
  key to join sync: the Drive copy gives the Sixkey server nothing [inferred]. The free backup stays a one-way disaster
  copy: no merge on upload, no live updates, no device list, no history (the latest copy only); that is the line to the paid cloud
  (the owner's answer 2: free for good, one-way).
- **Locked, "lock every time", PIN, Touch ID**: no effect; the upload needs no key. Restore needs the master password or the
  recovery key; a PIN or passkey never opens a cloud copy.
- **Shared profile** ("shared, vendor-synced or controlled by scripts", `types.ts`) [verified]: the backup goes to the account
  the profile is signed in to, which may not be the user's. Offered on the card (which names the account) but never by the
  popup's nudge or the first-run tail; a cloned profile writes through rule 7, so two clones fork instead of overwriting.
- **Plugins**: never involved; no plugin sees the backup state or the file [inferred].

---

## 5. The file route: iCloud Drive and the other drives

### 5.1 The idea

One click, the system save dialog (`showSaveFilePicker`) with "Sixkey 备份.json" suggested; the user picks iCloud Drive
(or OneDrive, Dropbox, Google Drive for desktop); Sixkey writes the same container as §1.2 there, and again after every
change; the operating system's own app uploads it. No sign-in, no Apple developer account, no CloudKit
(OWNER-DECISIONS/21 item 6).

### 5.2 What Chrome allows

- **The picker from an extension page**: `showSaveFilePicker` exists in extension pages; the worker has
  `FileSystemFileHandle`, `createWritable` and `queryPermission` but no picker [verified: probe's automated run, CfT 156].
- **iCloud Drive is not blocked.** Chromium's blocklist (`chrome_file_system_access_permission_context.cc`, `main` at
  `08da776`, 2026-10-29) blocks `~/Library` with all children, then un-blocks `~/Library/CloudStorage` ("Allow access to
  other cloud files, such as Google Drive"), `~/Library/Mobile Documents` and `~/Library/Mobile Documents/com~apple~CloudDocs`
  ("Allow access to iCloud files") as `kDontBlockChildren`: the folder itself cannot be granted, a file in it can [verified].
  So the save dialog works for a file in iCloud Drive, but a directory picker on the iCloud Drive root would be refused (a
  subfolder works) [inferred from the rule]. Since which Chrome version these exceptions exist [unverified]; the probe
  checks the owner's.
- **Persistence**: Chrome 122 added "Allow on every visit" to the prompt shown when a page re-requests a handle loaded
  from IndexedDB [verified: Chrome blog]; the blog does not mention extensions. In the source, the "every visit" grant is
  a content setting per origin, not specific to extensions [verified], and a grant that is not "every visit" is revoked
  when the last page of the origin closes (`OnLastPageFromOriginClosed` → `CleanupPermissions`) [verified].
- **The popup**: an extension popup or side panel has no permission prompt; since 2025-10-10 Chromium grants
  `requestPermission` there, in a click, with no prompt ("Auto-grant permission for extensions without request manager",
  crbug 449897860, commit position 1527946, which I place in Chrome 143 [inferred]) [verified].
- **The worker** cannot request (no frame: `kInvalidFrame`) [verified]; it can write when the grant exists.

### 5.3 What the automated half measured

Playwright's Chromium (Chrome for Testing 156.0.8078.4, headless), the probe loaded twice on one profile, 2026-10-30
(the result file is kept with the probe) [verified]:

| Check | Result |
|---|---|
| Worker writes through a handle the page stored in IndexedDB, grant present (OPFS) | ✓, before and after the "restart" |
| Worker writes to a real file with no write grant (a file dropped through DevTools) | `NotAllowedError`, no prompt |
| Worker's read grant on that file, 8 s after every extension page closed, same session | **`prompt`: revoked** |
| The same after the restart, before any page opened | `prompt` |
| `requestPermission` in a real click in a tab | no answer in 6 s (Chrome's prompt; nobody can click it headless) |

Not automatable: the native save dialog (iCloud Drive), Chrome's prompt and its "every visit" choice, the toolbar popup,
and a real browser restart (Playwright's relaunch delivers `onInstalled`, not `onStartup`).

**So, by default, the worker can write only while a Sixkey page is open.** Two ways out remain, and the probe tests both:
"Allow on every visit" for the extension's origin (then fully automatic), or the popup's silent re-grant (then one click in
the popup per browser start, and whether it lasts after the popup closes).

### 5.4 Edge and Brave

Edge is Chromium with the same File System Access code [inferred; Edge's own blocklist unverified]; the probe runs there
unchanged. Brave ships the API only behind a flag [transcribed: Chrome's File System Access article], so Brave users get
the manual export only.

### 5.5 The owner's probe

The probe's README (Chinese): load unpacked, ① pick a file in iCloud Drive, restart, ② one click (choose "每次访问时都允许"
if offered), restart, ③ in the toolbar popup only if asked. About 5 minutes, two restarts, at most three probe clicks. The
page tells the next step and shows a one-line result such as `A✓ B✓ M✗ C✗ D✗ J✗ I✗ E✓ F✓ L✓ G✓ K✓ H– N–`.

### 5.6 Decision rule

| Probe | Meaning | Ship |
|---|---|---|
| **G ✓** (after "every visit", a restart, the worker writes with no click) | Pick once, one click after the first restart, then automatic | **Yes**, as "自动备份到你选的文件" |
| G ✗, **H ✓ and N ✓** (popup re-grant is silent and the worker keeps writing after the popup closes) | One click per browser start, in the popup | **Yes**, as the second choice (the owner's answer 3): the popup shows "点一下继续备份到文件" after each start |
| G ✗ and N ✗ | Writes only while a Sixkey page is open | **No**; iCloud users keep the manual export, and Google Drive users use §1–§3 |

In every shipped form: the same container and rules (no device key, only the generation); a write never replaces a file
whose content is not what this device last wrote (another Mac writing the same iCloud file): "这个文件被另一台设备改过了 ·
另存为…" (the picker cannot create a sibling file without a folder grant); the suggested name carries a 4-character device
mark, "Sixkey 备份 7F3K.json", so two Macs do not pick the same file by default [inferred].

---

## 6. Where it shows, and the words

### 6.1 Placement

- **Settings › Backup, first card** (above 加密备份), in a lazy chunk `options/cloud.js` with its catalog.
- **The end of first run** (`SetupReady`): "要不要自动备份到 Google 云端硬盘？[开启] [以后再说]" — the moment the user thinks
  about losing things. Not in a shared profile.
- **The popup**: the header pill "本机" (title "只存在这台设备", which becomes untrue) shows the state; the footer keeps "N 个账户"
  and speaks only on a problem. "立即备份" (no backup for 7 days, `BACKUP_REMINDER_MS`) is the one click (the amendment):
  in that click it requests `identity`, then opens Settings › Backup with the Google card first and already connecting.
  The card's cost line is there from the first moment, beside the progress; it informs and never gates. The connecting
  runs in the settings tab because a popup closes when Google's window takes the focus.
- **Restore**: first run's welcome and "改为从备份恢复" screens, and Settings › Backup's restore card. The popup's welcome
  screen gets a second link beside "start-restore" (`#setup-restore`) that opens the same screen; the click that asks
  Google is always in the settings tab.

### 6.2 States

| State | Card (settings) | Popup header pill | Popup footer |
|---|---|---|---|
| off | the button | 本机 | as today |
| ok | 已备份到 Google 云端硬盘 · 3 分钟前 | ☁ 已备份 (title: the card's sentence) | N 个账户 |
| uploading | 正在备份… | ☁ 已备份 | N 个账户 |
| changes waiting, offline | 有改动还没备份 · 联网后会自动备份 | ☁ 已备份 | N 个账户 |
| failed < 3 days | 备份没成功：{原因} · 会自动重试 | ☁ 已备份 | N 个账户 |
| failed ≥ 3 days with changes waiting (stale) | 已经 3 天没备份成功：{原因} | ☁ 备份已停 (amber) | N 个账户 · 备份出了问题 |
| needs reconnect | 需要重新连接 Google 云端硬盘 · [重新连接] | ☁ 备份已停 | N 个账户 · 备份出了问题 |
| Drive full | Google 云端硬盘空间已满，备份没成功 | ☁ 备份已停 | N 个账户 · 备份出了问题 |
| notices (once) | 云端的备份文件不见了，已重新建了一个 / 另一台设备也在写这个备份，本机已改存到「Sixkey 备份 (2)」/ 本机的数据是从较早的副本恢复的，云端可能有更新的备份 · 从云端恢复 | — | — |

### 6.3 Wording (proposals; the settled table is CLOUDBK-NOTES §7)

| Key | zh_CN | en |
|---|---|---|
| card title (off) | 自动备份到 Google 云端硬盘 | Automatic backup to Google Drive |
| card body (off) | 加密后存进你自己的云端硬盘。之后账户有改动就自动备份，换电脑时输主密码就能恢复。 | Encrypted and kept in your own Google Drive. After that, every change is backed up by itself, and on a new computer your master password brings it back. |
| button | 备份到 Google 云端硬盘 | Back up to Google Drive |
| cost line | 能用主密码或恢复密钥打开。能进入你 Google 账户的人可以试着猜主密码，主密码越难猜越安全。 | It opens with your master password or recovery key. Anyone who gets into your Google account could try to guess your master password; the harder it is to guess, the safer the backup. |
| cost line, option c | 只能用恢复密钥打开，能进入你 Google 账户的人没有密码可猜。已经被人下载的旧副本不受影响；要让它打不开以后的备份，请「更换加密密钥」。 | Only your recovery key opens it, so someone in your Google account has no password to guess. A copy someone already downloaded is not affected; to cut it off from later backups, replace the encryption key. |
| switch | 只用恢复密钥打开云端备份 | Open the cloud backup with the recovery key only |
| switch hint | 最好在第一次备份前选好：之后再改，只保护以后上传的备份。 | Best chosen before the first backup: changing it later protects only what is uploaded from then on. |
| latest only | 云端只留最新的一份，较早的版本会自动删除。 | Only the latest copy is kept in Drive; older versions are deleted. |
| ok | 已备份到 Google 云端硬盘 · $1 | Backed up to Google Drive · $1 |
| where | $1 · 我的云端硬盘 › Sixkey · 在云端硬盘中查看 | $1 · My Drive › Sixkey · View in Drive |
| failed | 备份没成功：$1 · 会自动重试 | Backup failed: $1 · Sixkey will try again |
| reasons | 连不上 Google / Google 暂时出错 | Can't reach Google / Google had a problem |
| reconnect | 需要重新连接 Google 云端硬盘 · 重新连接 | Reconnect Google Drive to keep backing up · Reconnect |
| full | Google 云端硬盘空间已满，备份没成功 | Your Google Drive is full; the backup failed |
| too large | 保险库太大，超过了云端备份一次能传的大小 | The vault is too large for one cloud backup upload |
| forbidden | Google 不允许 Sixkey 写入云端硬盘（可能是单位管理员的设置） | Google does not let Sixkey write to your Drive (perhaps your organisation's policy) |
| off | 停止自动备份 · 云端硬盘里的备份文件会留着，你可以自己删 | Stop automatic backup · The file stays in your Drive; you can delete it yourself |
| popup pill | 已备份 / 备份已停 | backed up / backup stopped |
| popup footer | $1 · 备份出了问题 | $1 · backup problem |
| restore button | 从 Google 云端硬盘恢复 | Restore from Google Drive |
| restore found | 找到云端硬盘里的备份（$1） | Found your backup in Google Drive ($1) |
| restored | 已恢复 $1 个账户 | Restored $1 accounts |
| restored, older password | 另一台电脑上的主密码比你输入的新。可以现在设一个新主密码，两台电脑以后都用它 · 设置新主密码 · 以后再说 | The master password on another computer is newer than the one you typed. You can set a new one now and use it on both · Set a new master password · Later |
| restored, older key | 另一份备份用的是旧的加密密钥；请在那台电脑上也更换加密密钥 | Another backup uses an older encryption key; replace the key on that computer too |
| not read | 还有 $1 份备份没有读取 | $1 more backups were not read |
| file route link | 用 iCloud 云盘或别的网盘？自动备份到你选的文件 › | Using iCloud Drive or another drive? Back up to a file you choose › |

Final wording goes through `scripts/i18n/` (a `cloudbk.py` fragment) and the store-copy owner (OWNER-DECISIONS/06).

### 6.4 The popup's budget

Measured on a build of `2e260d0` [verified]: popup 57,116 of 61,440 B gz (gate closed; static 52,681 + the larger
catalog 4,435), side panel 59,349 of 63,488. The owner's floor is 1,500 B of headroom with the Sync section in
(QUICKVIEW-NOTES). The popup's static code gains only reading `sk_cloud_cfg`/`sk_cloud_state` in the load it already
makes (`loadView`'s `also` keys) and a state enum for the pill and footer: about 150 B gz [estimate]. Its six strings go
in a lazy `cloud-popup` catalog (about 250 B gz [estimate], its own budget of 1,024 B, the `plugins-popup` pattern), loaded
only when backup is on. The worker's code (the transport, the Drive client, the rules, auth) is in `sw.js`, which has no
gzip budget of its own today; check-dist reports its size and patch 4 sets one. Built: 112 KB gz (114,688 B) in the
minified builds; the store build's `sw.js` went from 89,649 to 101,086 B gz with patch 4 (CLOUDBK-NOTES §6).

Built in patch 6: the pill, the footer and the one click are a lazy chunk (`popup/main/CloudPop.tsx`) with the lazy
`cloud-popup` catalog, 4 keys, 168 B gz (zh_CN), budget 2,048 B; the popup's static code gains the chunk's loading and
the pill's colour. A store build that hides the cloud backup drops all of it (CLOUDBK-NOTES §8).
### 6.5 The settings page's budget

Measured [verified]: "settings page with a vault" 11,503 of 12,288 B; "every part" 12,022 of 12,288 (266 B left); "a vault's
page with the plugins' text and every other lazy catalog in" 15,170 of 15,360 B zh_CN (**190 B left**); the `settings-backup`
part 1,192 of 3,072. The card's text (about 25 keys, 1.2 KB gz [estimate]) fits no aggregate as it stands. Proposal: a lazy
catalog `cloud` with its own budget (2,048 B), loaded by the Backup section, first run's restore and its last screen;
held, with a vault's view, to `SHARES_PAGE_LIMIT` as its own aggregate (`CLOUD_VIEW` = the vault view + `cloud`), and left
out of `PLUGINS_VIEW`, as BUDGET3-NOTES §2 already did for the firstrun part (a page that opens every section in turn would
hold about 1.2 KB more than any limit). This is a budget rule change: the maintainers' to decide, or the owner's if the
maintainers prefer (it was not one of the owner's four questions).

Settled (2026-10-31, the maintainers) and built in patch 5: `cloud` holds 59 keys, 1,770 B gz (zh_CN), budget 3,584 B;
`CLOUD_VIEW` (a vault's view with it) 12,783 of 15,360 B and `CLOUD_FIRSTRUN_VIEW` (first run's with it) 5,866 of
15,360 B; `PLUGINS_VIEW` unchanged. The card's text is in no settings part, so the vault view did not grow.

---

## 7. Owner tasks

### 7.1 Before the 10-minute check

1. **Google Cloud project for the dev build** under the owner's identity (console.cloud.google.com): **"Sixkey dev"**, a
   project of its own, never the store build's "Sixkey" (§7.3): `drive.file` grants are per project, so the two builds
   never see each other's files (review r3, P3-03; the same rule as `scripts/google-oauth.mjs`). Enable the **Google
   Drive API**.
2. **OAuth consent screen** (Google Auth Platform): app name Sixkey, support e-mail, developer contact; audience **External**;
   data access: add `.../auth/drive.file` only. Status "Testing" with the owner's account as test user for now.
3. **Client 1, type "Chrome Extension"**, Item ID `pgnlbjikdnniepfeijffpefifnojjege` (the dev build).
4. **Client 2, type "Web application"**, authorised redirect URI `https://pgnlbjikdnniepfeijffpefifnojjege.chromiumapp.org/`.
   Both clients in the **same** Cloud project, always (this one for the dev build, "Sixkey" for the store build): a
   grant is the project's, so "断开" revoking one token withdraws the grant of both clients ("Revocation removes all
   OAuth 2.0 scopes previously granted to a project", Google's OAuth 2.0 documentation), and a file made through one is
   listed through the other (§3.6). Two projects would leave the other client's grant standing after "断开", and a
   restore in another browser would not see the backups (REVIEW-P5P6-r3, C4).
5. Send the two client IDs (they are not secrets; the web client's secret is not needed and is never put in the code).

### 7.2 The 10-minute check (after patch 3, with the dev build)

The dev build, and no other, has a developer page, `chrome-extension://pgnlbjikdnniepfeijffpefifnojjege/devcloud/index.html`
(built in patch 3; `src/devcloud/`). It needs the dev build's two client IDs, made in the "Sixkey dev" project of §7.1,
in `scripts/google-oauth.mjs`, and `npm run build:dev`; without them it says "not configured" and asks Google for
nothing. Its files carry `sixkey: "devcheck"`, which no restore lists, and it lists only its own. The sign-in runs in
the page (Google's window needs a tab); everything else runs in the worker, the one context that reaches the network.
Its buttons, in order, each printing ✓/✗ and the error's code, never a token:

1. **连接（Chrome）**: `permissions.request(identity)` in the click; then the page opens itself in a new tab, which starts
   `getAuthToken({interactive: true})` as it loads, with **no click** (the amendment's "no gesture needed", as the popup
   opening the settings page will) → Google's "允许". Expected ✓; if Chrome wants a gesture, the card keeps its button
   for that one case.
2. **上传测试文件**: creates My Drive › Sixkey-dev › test.json with appProperties; prints id and headRevisionId.
3. **列出 / 下载 / 比较**: the §3.6 query finds it; the bytes match.
4. **改写**: an update keeps the id, changes headRevisionId; a second update with a stale head is refused by rule 7 (fork).
   Then the page lists the file's revisions and deletes the older ones (`revisions.delete`), and it makes and deletes
   one scratch file of its own (`files.delete`): both must work under `drive.file` (§3.2, §3.3; review r2 CB-01); the
   line says how many revisions were deleted and are left, and whether the file is gone.
5. Quit Chrome, reopen, **静默取令牌**: `getAuthToken({interactive: false})` from the **worker** with no UI → ✓ expected;
   the line names the account `about.get` gives under `drive.file` (§11 item 3: the account pin needs it).
6. **连接（网页方式）** in Chrome, then in Edge (load the same dev build there): `launchWebAuthFlow` interactive, then
   non-interactive with `prompt=none`; then **列出** in Edge must find the file made in step 2 through client 1.
7. **断开**: revoke, `removeCachedAuthToken`, `permissions.remove(identity)`; step 5 then fails with "needs reconnect".

### 7.3 Before release

- Store extension ID (first submission, OWNER-DECISIONS/11) → a Chrome Extension client for it, its redirect URI on the web
  client, and the same for the Edge Add-ons ID; all of them in the one "Sixkey" project (§7.1 item 4: one project, one
  grant, so "断开" withdraws it whole).
- **Brand verification** (homepage on a domain the owner verifies in Search Console; privacy policy on the same domain,
  linked from the homepage and the consent screen), then publish the app **In production** (else tokens lapse in 7 days).
- **Privacy policy** text (from patch 8's PRIVACY.md) on that domain, with the Limited Use statement; the store's privacy
  tab and the `identity` justification.

---

## 8. Implementation plan

Each patch is reviewable alone, ends with `npm run verify` green, and is committed locally only.

| # | Patch | Content | Tests | Size [estimate] |
|---|---|---|---|---|
| 1 (built) | `core/cloud/` (pure) | the container (build, parse, `checkGeneration`, the device-key refusal, the generation-only rule, option c's filter); the write decision (create / update / fork / skip, rules 1–8) and what it deletes (§3.3); the status derivation (§6.2); restore's candidate set, single derivation per wrap, the held vault key, the work bound, the merge by vault, the keyring by newest wrap | unit + fast-check (rules hold for any history of writers; restore of any subset loses no entry; two vaults in any order) | 500 + 700 lines, 2–3 days |
| 2 (built) | `core/cloud/drive.ts`, `core/cloud/remote.ts` | the Drive v3 calls used (about, list with pages, create multipart, folder, get metadata, download, update media, revisions list and delete, file delete) over an injected transport, with the error mapping and its map to the status; one upload by the write rule (`runBackup`) and the restore's download (`fetchBackups`); `test/helpers/fake-drive.ts` (revisions, 401/403/404/429/5xx, quota full, a file deleted or trashed by the user, access revoked, concurrent writers). The fetch transport moved to patch 4, with the network rules it belongs to | unit against the fake, fast-check over interleaved devices | see CLOUDBK-NOTES |
| 3 (built) | `platform/google-auth.ts`, `platform/google-transport.ts`, `scripts/google-oauth.mjs`, dev page `devcloud/` and its worker end | Chrome path, web path (state check, redirect read, session token, silent refresh with the pinned account's `login_hint`), the permission asked in a click, revoke (every token held); the fetch transport (from patch 4) with its endpoint allowlist; the account pin's logic (`pinAccount`, `runBackup`'s `account`); the client IDs' one place; the §7.2 page, in the dev build only, with its manifest, CSP and check-dist rules | unit with fake `chrome.identity`, a fake fetch and the fake Drive (with accounts); source rules; a smoke run of the dev page; the owner's 10-minute check | see CLOUDBK-NOTES |
| 4 (built) | worker wiring | the store build's use of `platform/google-transport.ts` (built in patch 3); the account pin's call sites (P3-01): at connect the page has the worker record `pinAccount` in `sk_cloud_cfg.account`, every run passes it to `runBackup` (a token of another account: "wrong_account", status reconnect, nothing written), and the auth's `hint` reads its address for the silent renewal; the `persist` of R2-02 into `sk_cloud_cfg.link`; `sk-cloud-soon` after commits (as `sk-sync-soon`), the 30 s alarm, retries, the daily check, `beforeRecoveryWrite` → fork flag, sender-policy rows; manifest per flavour (`oauth2`, optional `identity`), CSP; check-dist rules (§2.5) and a `sw.js` size line; review r3's S1–S6 (§3.3; §2.1's two ways, their core) | unit; check-dist tests; e2e: the e2e build swaps the transport for an in-extension fake Drive (no network: the e2e CSP keeps Google out, so a real request fails) | see CLOUDBK-NOTES |
| 5 (built) | settings card, restore, first-run tail | lazy `options/cloud.js`, the `cloud` catalog and its budget rule (§6.5), the restore flow (§3.6) in first run and Backup (after an `outdated` password restore, the offer of "设置新主密码" with the vault key in hand, skippable; `olderKeys` said; the `merged` list of §3.3 for the worker's next run, bound to the generation it merged into, sent right after that commit as `sk-cloud-merged`; §2.1's two ways after another account; `sk_last_backup` on success), `选择文件` learning `sixkey-cloud-backup` | unit; e2e with the fake: connect, upload after an edit, fork, revoke, full Drive, restore merging two files, wrong password | 700 + 800, 3 days |
| 6 (built) | popup and side panel | the pill and footer states, `cloud-popup` catalog, the welcome screen's link to the cloud restore | e2e; budget checks | 150 + 250, 1 day |
| 7 | file route (only if §5.6 says so) | `platform/file-backup.ts`, handle in `sixkey-files`, writes from pages and from the worker when granted, the popup's re-grant if chosen, the content check | unit with fake handles; e2e with OPFS handles (the probe's method) | 400 + 400, 2–3 days |
| 8 | docs | PRIVACY.md, ARCHITECTURE §2–§4, §7, local-vault.md, `docs/design/notes/CLOUDBK-NOTES.md`, store privacy text drafts | doc checks in `test/unit` that name keys | 1 day |

About **16 to 20 team-days** plus review rounds, as with PRF and PIN-RESTART [estimate]. Patches 1–4 are built (2026-10-31);
patch 3's manual check waits for the OAuth clients; patch 7 waits for the probe.

---

## 9. The owner's decisions (2026-10-31, OWNER-DECISIONS/21)

Each answer is the recommended option.

1. **What opens the cloud backup:** the master password or the recovery key, as on this computer, with the card's switch
   "只用恢复密钥打开" (option c). The cost line is always on the card: warn, never block.
2. **The free backup and the paid cloud:** the Google Drive backup is free for good, a one-way disaster-recovery copy; the
   paid cloud is live sync across devices, 30-day history, device approval and revocation.
3. **The file route:** built as the second choice even if the probe shows it needs one click after each browser start
   (said plainly in the status). It waits for the owner's probe run.
4. **Edge:** ships in the same release as Chrome; there "automatic" lasts while the user stays signed in to Google.

---

## 10. Risks and kill criteria

| # | Risk | Watch | Kill or change |
|---|---|---|---|
| R1 | The Google account becomes the gate to both factors (§1.3) | — | Accepted only with the card's line; option c always available |
| R2 | `getAuthToken({interactive: false})` needs UI after a restart | §7.2 step 5 | If so, Chrome is "one click per start": rethink before patch 4 |
| R3 | Google withdraws the implicit flow, or `launchWebAuthFlow` with Google stops working in Edge | §7.2 step 6 | Edge/Brave lose Drive backup (file route or manual) |
| R4 | `drive.file` reclassified sensitive (verification, possibly a paid annual assessment) | Google e-mails, grace period [verified: help 7454865] | Reconsider; `drive.appdata` has the same class today |
| R5 | Store review rejects the disclosure | first submission | Adjust the privacy tab; the code needs no change |
| R6 | Two writers of one lineage race inside the same second | fake-Drive tests | Accepted (low: different content within about a second): the one overwritten forks at its next change, and until then its last upload is on its disk only (§3.3 rule 7). A daily check that forks when the head moved and nothing changed would close it |
| R7 | A silent stop (grant lapse, quota, Google's time-limited access) | the status line, the popup pill, the 3-day stale rule | — |
| R8 | The file route works only with a page open | the probe | Do not ship it (§5.6) |
| R9 | The budget rule for `cloud` is refused | maintainers | Cut the card's text or move other text out of the vault view first |
| R10 | Google learns usage and timing metadata | — | Stated in PRIVACY.md; unavoidable with any Google storage |
| R11 | A copy downloaded before a change of secret keeps the old wraps (§1.5); so does a file in Drive's trash, for up to 30 days | — | Stated on the card; "更换加密密钥" cuts it off from later uploads |
| R12 | `revisions.delete` or `files.delete` refused under `drive.file` | §7.2 step 4 | The latest-copy rule cannot hold: say on the card that Drive keeps older versions for about 30 days, before patch 4 |

---

## 11. Unverified claims

1. `getAuthToken({interactive: false})` returns a token after a browser restart with no UI (§2.1).
2. The interactive auth calls can run from the service worker (§2.1).
3. ~~`about.get` with `drive.file` always returns the account's e-mail~~: it may not (Drive's User resource, verified
   2026-10-31); the pin holds the id alone then (§2.1). Open: that `permissionId` stays the same when the address
   changes (§2.1, [inferred]).
4. Brave's `getAuthToken` fails and its `launchWebAuthFlow` works with Google (§2.2).
5. Google requires the client secret for a web client's code exchange even with PKCE (§2.2).
6. `launchWebAuthFlow` with `prompt=none` refreshes silently in Edge while signed in to Google (§2.2).
7. A file created through one OAuth client is listed through another client of the same project (§3.6).
8. Drive v3 has no compare-and-swap on `files.update`, and v2's `If-Match` on the file etag still returns 412 (§3.3).
9. Purgeable revisions count toward the Drive quota (§3.5).
10. The Chrome version in which iCloud Drive and `~/Library/CloudStorage` were un-blocked (§5.2).
11. "Allow on every visit" is offered to and persists for a `chrome-extension://` origin (§5.2; the probe).
12. The popup's silent re-grant lasts after the popup closes (§5.2; the probe).
13. Edge uses Chromium's blocklist unchanged (§5.4).
14. PRF with iCloud Keychain passkeys from an extension page in Chrome (§1.4).
15. The settings page can start the interactive `getAuthToken` as it loads, with no user gesture (§2.1, the amendment).
16. `revisions.delete` and `files.delete` work under `drive.file` on the app's own file (§3.2, §3.3; the reference lists
    the scope).
17. Edge's `getRedirectURL()` is `https://<id>.chromiumapp.org/` as Chrome's, and `launchWebAuthFlow` runs from Edge's
    service worker for the silent renewal (§2.2; §7.2 step 6).

## 12. Sources

- Repository (`2e260d0`): `extension/src/core/backup/backup.ts`, `src/core/storage/format.ts`, `store.ts`,
  `src/core/crypto/keyring.ts`, `kdf.ts`, `envelope.ts`, `src/background/sw.ts`, `src/options/Backup.tsx`,
  `src/popup/main/Main.tsx`, `src/platform/file-access.ts`, `fetch-transport.ts`, `manifest.base.json`, `manifest.dev.json`,
  `scripts/check-dist.mjs`, `scripts/messages.py`; `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`, `docs/SYNC-DESIGN.md` (D2,
  §4.7), `docs/design/proposals/RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md` (§1.2, §1.3, §2.4–§2.7), `OWNER-DECISIONS/11`,
  `15`, `21`.
- Chrome: [identity API](https://developer.chrome.com/docs/extensions/reference/api/identity),
  [OAuth 2.0 for extensions](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth),
  [permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions),
  [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list),
  [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
  [user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
  [persistent permissions for File System Access](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api).
- Chromium `main`: `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc` (commit `08da776`,
  2026-10-29; the auto-grant commit `ecb83649e5`, 2025-10-10, crbug 449897860), `file_system_access_tab_helper.cc`.
- Google: [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
  [revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions),
  [properties](https://developers.google.com/workspace/drive/api/guides/properties),
  [search](https://developers.google.com/workspace/drive/api/guides/search-files),
  [about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get),
  [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
  [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2),
  [client-side implicit flow](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow),
  [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
  Google Cloud help [13463073](https://support.google.com/cloud/answer/13463073),
  [13464321](https://support.google.com/cloud/answer/13464321), [7454865](https://support.google.com/cloud/answer/7454865).
- Microsoft: [Supported APIs for Edge extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support).
- Measured here: curl CORS preflights to `www.googleapis.com` and `oauth2.googleapis.com` (2026-10-30); the probe's
  automated run (2026-10-30); a build of `2e260d0` for the budgets.
