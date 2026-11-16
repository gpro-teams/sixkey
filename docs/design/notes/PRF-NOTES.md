# Device unlock: Touch ID and Windows Hello (QUICK-UNLOCK Stage 2): notes

The owner's model (OWNER-DECISIONS/15, 2026-10-22): their own memorable master password, typed rarely; a PIN and the
fingerprint for every day; the recovery key for recovery only. Touch ID that also works after a browser restart, through
a passkey that syncs, is what they asked for ("自动授权(输入 pin 码或者验证指纹就行)"), and the step after Shamir (item 5).
This is Stage 2 of `docs/design/proposals/QUICK-UNLOCK.md` (§8), built as specified there (owner decisions Q1–Q3, §0.5;
the Mac probe results, §0A), unless §11 below says otherwise. Stage 1 (the PIN, the soft and hard locks) is
`QUICK-PIN-NOTES.md`; nothing of it was rewritten, only taught that sk_quick has a second method. **2026-10-30 (OWNER-DECISIONS/20, its
second note; PIN-RESTART-NOTES.md §18):** the PIN no longer lives in `sk_quick`; it is its record on disk only, with no
time limit, also after a restart; `sk_quick` holds the gate's arming alone (method `"device"`). Where this text says the
PIN and the gate share one arming or "the same 12 hours", that is history: the gate keeps its 12 hours, the PIN has
none; the 5th wrong PIN still ends the gate (Q1), and a key change still pauses both. The visible text says
"recovery key" / 恢复密钥 (OWNER-DECISIONS/16 Q-C); identifiers, storage keys and log kinds are unchanged.

## 1. What a person sees

**Settings › Security**, under the PIN box: a box **Unlock with Touch ID** (Windows Hello on Windows, "this computer's
sign-in" elsewhere: the name follows the platform, for the words only). Locked, it lists what is enrolled. Opened and
unlocked:

- the lead, the master password field (every change asks for it), and for each credential **Turn back on** (after a key
  change) and **Remove**;
- an unticked checkbox, "Allow a passkey that syncs to Apple, Google or your password manager" (Q2, quickSyncedOptIn).
  Ticking it shows the notice at once (quickSyncedNotice: the passkey is kept in that company's cloud and on your other
  devices; whoever gets into that account and also has a copy of this browser profile could open Sixkey without the master
  password; leave it off if unsure), with one more sentence when sync is on (§5.9's residual). Never offered in a profile
  declared shared. Then one line on what to pick in Chrome's dialog (§0A.5 item 4), and **Use Touch ID**. Chrome asks
  twice: create, then the check.
- the answer: "Turned on.", or what was not had: "This passkey syncs, so it works only until the browser closes. For
  restarts too, remove it and add it again with the box ticked." (prfSyncedRefused: the provider refuses the same
  passkey twice, so adding it again without removing it first would only answer "Added already."; revision 2, REVIEW
  F2), "This passkey has no key of its own for Sixkey: it works until the browser closes.";
- each credential: its name, "Synced" when it is, the date added, and its honest line: "Also after a restart. A copy of
  this browser profile still needs your master password." (synced: "Also after a restart. Synced: that account plus a copy
  of this browser profile can open Sixkey too."), for a gate quickOnGate's substance ("Until the browser closes. It stops
  people at your computer, not programs on it or anyone who opens the browser's developer tools."), "Not used in this
  security mode." in a shared profile, "Keys replaced: Touch ID is paused until you turn it back on in Settings." after a
  key change (for a gate too since revision 2);
- with a gate armed and no PIN, "End quick unlock and lock" (the PIN box's button, in this box too: revision 2); beside a
  synced gate, **Also after a restart** (OWNER-DECISIONS/17 Q4): the synced notice (quickSyncedNotice) first, then
  **Use Touch ID**, one touch: the same credential becomes a persistent one, no new passkey;
- right after a key change made on this page (Settings › Security › Password and recovery), once the new recovery key is
  saved: "Keys replaced: turn Touch ID back on with one touch, no password." with a **Turn back on** and its own answer
  for each paused credential (OWNER-DECISIONS/17 Q3; REVIEW-r2 G4);
- "Not working here, or lost this computer? Remove it: your master password and recovery key still open Sixkey."
  (quickNothingLost and §5.6's "not working? Remove", in one line).

**The lock screen** (the popup, the side panel, and the settings page's unlock bar): above the field, one real button
**Unlock with Touch ID**, focused (Enter starts it), and under it "Your computer will ask you to confirm it's you. The
request may say “chrome-extension”: that is Sixkey." (unlockWindowNote). It never starts by itself (§1.6: the
no-interaction `get()` is unmeasured). Where a PIN field is shown too, the PIN keeps the focus, so digits typed after the
shortcut still land in it. Lines instead of the button: "Sixkey asks for the master password every 14 days, so that you
don't forget it." (the 14 days are over), the paused line after a key change, and "Touch ID needs the master password
once after a browser restart, and every 12 hours." (the gate waits for the master password, which arms it with the PIN).
With a PIN and a gate both armed (OWNER-DECISIONS/17 Q1) the lock screen shows both: the PIN's field and the button. A cancel or a failure
moves the focus to the master password's field; a failure also says "That didn't work. Use your master password."

## 2. Records and cryptography

**`sk_prf`** (`chrome.storage.local`; `src/core/crypto/prf-record.ts`), §5.2's PrfRecord with one field more:

```ts
type PrfRecord = { v: 1; vaultId; creds: PrfCred[] /* ≤ 10 */; lastPasswordAt?: number; session?: "pin" };
type PrfCred = {
  id; kind: "platform" | "security-key" /* Stage 4's, never used */; mode: "prf" | "gate"; name /* ≤ 40 code points */;
  synced: boolean /* BE at enrolment */; provider?: "icloud" | "google" | "chrome" | "windows" /* from the AAGUID */;
  createdAt; salt?; wrap?: { vkId; iv; wrapped } | null /* "prf" */; publicKey?; alg?: -7 | -257 /* "gate" */;
};
```

- (`session: "pin"`, the user's pick between the gate and the PIN, was dropped with OWNER-DECISIONS/17 Q1: both are armed
  at once; the lazy side leaves an unknown field out and stores the record healed.) `provider`: where the passkey lives, from the AAGUID the creation returned (Google Password
  Manager, Apple Passwords and its managed variant, Chrome on Mac, the three Windows Hello ones; the community list
  [transcribed] as §0A has it), so the removal says where to delete it (Chrome's own passkeys are named with Google
  Password Manager, whose page lists them); unknown: "your passkey provider".
- The PRF wrap is exactly §5.2 / YUBIKEY §1.2.1: `KEK = HKDF-SHA256(PRF output, ∅, "sixkey/v1/kek-prf")`, AES-256-GCM,
  `AAD = "sixkey-prf|1|{vaultId}|{vkId}|{credId}"`, the key's id checked after the unwrap (`src/core/crypto/prf.ts`). The
  salt the PRF is evaluated at is 32 random bytes per credential, passed as `first` at creation (§5.3: Windows Hello is
  said to report PRF support only then [unverified, §1.5]) and in every `get()` (`evalByCredential`); "turn back on"
  makes a new one. The classification never relies on what the creation reports: the verification `get()` decides (§3).
  The label and the tag are in the contract test's list of local-only labels (distinct from every contract label and
  tag, prefix-free).
- A gate holds **no key material**: its SPKI public key and algorithm, to check that an assertion carried user
  verification, and since revision 2 (REVIEW S1) a **MAC** of them, `mac: {vkId, tag}`:
  `tag = HMAC-SHA256(HKDF-SHA256(VK, ∅, "sixkey/v1/gate-mac"), "sixkey-gate|1|{vaultId}|{credId}|{alg}|{publicKey}")`
  (`prf.ts` gateMac / gateMacOk), written at enrolment and "turn back on" and checked only on the lazy side, by the gate
  unlock with the key the arming parked. A gate credential planted in the profile's storage (its planter's own
  authenticator) is never asked for. The main chunk only compares `mac.vkId` with the vault key's id (0 B of HMAC there):
  after a key change a gate is paused ("turn back on") exactly as a PRF credential is, and is not armed meanwhile (the
  PIN alone is). A gate is also one only with a public key stored as a string (REVIEW S2).
- **Two readings of one record.** The popup's main chunk checks only its shape (`parsePrfRecord`: the version, the vault id
  is a string, the credentials an array of at most 10, the type of the time); what it decides from it is
  which button and line the lock screen shows, whether the master password arms the gate, and which wraps a key change
  pauses. Every field of every credential is checked (`src/core/crypto/prf-check.ts` `credOk`: the id, the kind, the name,
  the salt, the wrap's sizes, the key's size and algorithm) before anything of it is used to unlock, listed or written, by
  the lazy chunks; a full check in the main chunk would cost the popup's counted bundle about 300 B (§9). The lazy side
  reads the record with its usable credentials only (`usableRecord`), and its next write stores it so, healed: an unusable
  credential (written past these checks, by hand or a tool) never hides the usable ones, and a gate that can never open
  does not keep the PIN away for more than one master password. Its passkey stays in the OS.

**`sk_quick`, method `"device"`** (`chrome.storage.session` only; `src/core/crypto/pin.ts` QuickDevice): the gate's
arming, `{v, method: "device", vaultId, vkId, armedAt, expiresAt, vk, wraps}`. `vk` is **the vault key itself**, as in
`sk_session`: not protected; the gate is the UI (§5.2 says so, and so does the label). The PIN's hours and clock rule
(`quickLive`, now for both methods), and `wraps` (Stage 1's review M1): any re-wrap of the keyring ends it.

**Nothing else is stored**: no PRF output, KEK, challenge or assertion, anywhere (`test/unit/prf-service.test.ts` looks
for every one of them in `chrome.storage.local` and the diagnostics after every path). The PRF output is zeroed once used.

## 3. Classification: by what the authenticator returned, never by the OS

At enrolment (`src/core/service/device-admin.ts` `enrol`): create(), then one get() with the salt, which decides (YR-28):

| The verification `get()` | BE flag (creation) | Opt-in ticked | Credential | Answer |
| --- | --- | --- | --- | --- |
| `results.first` (32 bytes) | 0 | either | **prf** | "Turned on." |
| `results.first` | 1 | no | **gate**, synced | prfSyncedRefused |
| `results.first` | 1 | yes | **prf**, synced | "Turned on."; listed "Synced" |
| none | either | no | **gate** | "Turned on." (the list: until the browser closes) |
| none | either | yes | **gate** | "This passkey has no key of its own for Sixkey …" |

`prf.enabled` is never read (a source rule holds it). Before anything is saved the creation must be a platform
authenticator's (not `cross-platform`), with UP and UV, our challenge, origin and RP ID hash, and an ES256 or RS256 public
key; and the verification assertion must pass the gate's own check (§5) with that very key: a gate saved here always
opens. A refusal saves nothing ("refused"; the passkey Chrome made stays in the OS). Security keys (Stage 4) are not
enrolled: the request asks for a platform authenticator, and a `cross-platform` answer is refused.

The OS is used for two things only, both §5.3/§1.6's: the name in the words, and where the ceremony runs (§6).

## 4. The service

The settings page's operations are `DeviceAdmin` (`device-admin.ts`, built only by the box, a lazy chunk); the lock
screen's are `DeviceUnlocker` (`device-unlock.ts`, a lazy chunk the popup, the side panel and the unlock bar load). Both
reuse the service's own steps by element access, as `pin-admin.ts` and `sync-flows.ts` do; `m2-source-rules` allows it in
these four files only. `sk_prf` is written in two places only: `prf-store.ts` (every context's runtime: the key change's
step) and `prf-write.ts` (lazy: everything else, through the store's own KV and vault lock, one critical section each).

- **Enrol**: unlocked, a master password (not a Phase 0 device-key vault), the master password typed again
  (`verifyPassword`: wrong_secret, recorded as unlock_failed, before any ceremony), at most 10. The synced opt-in is refused
  in a profile declared shared (quick_off). One locked write of `sk_prf`, only while the vault and key are still the ones
  just checked, with `lastPasswordAt` = now (the 14 days start); `prf_enrolled`; a gate, in a solo profile, is armed at
  once (the master password was just typed), with the PIN when one is set up, from now, in place of whatever was armed.
- **Remove**: the master password again. Only when it is the last gate credential of this key is the gate's half of the
  arming taken away first (a gate-only arming deleted; the PIN's kept as armed, its hours and tries unchanged; another
  gate still opens it; a PRF credential has none: revision 2, REVIEW S3); then the credential (the record goes with its
  last one), then `prf_removed`.
- **Turn back on**: the master password again; for a PRF credential one get() with a new salt and the wrap under the
  current key; for a gate (revision 2) one get() whose assertion passes the gate's check with its stored key, and a new
  MAC under the current key, the gate armed at once (with the PIN); the 14 days start; `prf_enrolled`. Right after this
  page's own key change (`VaultService.rotateKey`, which notes the new key's id and time for this page only:
  `rotated.ts`), for 10 minutes, it asks for no master password again (OWNER-DECISIONS/17 Q3): one touch; any other
  page, or later, wrong_secret. The gate's arming and the 14 days then count from the key change, when the master
  password was typed, not from the touch.
- **Also after a restart** (`alsoAfterRestart`, OWNER-DECISIONS/17 Q4): a synced gate of Sixkey's own (its MAC checks),
  in a solo profile, with the master password again: one get() with a new salt whose answer is that credential's (the
  gate's check with its stored key), UV, a PRF output; the wrap under the current key replaces the gate's fields; the 14
  days start; `prf_enrolled`; when it was the last gate, the gate's half of the arming goes. A provider that gives no
  PRF after all: it stays a gate, nothing written, and the box says so (dvNoPrf).
- **End quick unlock now** is in the box too for a gate with no PIN beside it (revision 2, REVIEW S9: the PIN box's own
  words and service step, `DeviceAdmin.endQuickUnlock`).
- **Arming** (`ServiceCore.arm`, after every master password or recovery key unlock, as Stage 1): one `sk_quick` record
  from now: the PIN's when it is set up, carrying the gate's half (`gate`: the vault key itself, as a gate-only arming
  holds it) when a gate credential of this key is enrolled, or the gate's alone (`QuickDevice`) without a PIN
  (OWNER-DECISIONS/17 Q1: both at once, the same hours); never in a shared profile. Either half opens Sixkey; neither
  unlock moves the hours; whatever ends the record ends both (a hard lock, its 12 hours, the 5th wrong PIN: someone is
  guessing at the keyboard). The PIN's changes (set, removed) touch the PIN's half only; setting it, with the master
  password typed, arms both from now.
- **A key change**: the cleanup (`PrfStore.reencrypt`, a `VkRecord`) sets every PRF wrap under another key to null and keeps
  the credential ("turn back on"); a gate's MAC is left as it is, made under the old key it no longer counts (paused,
  "turn back on"); a record for another vault, or not shaped like one, is removed. Every key event already
  ends the session quick unlock (`committed()`), so the gate's arming goes too. A new vault (`makeVault`: create, restore,
  start over) removes a record of another vault (§7.1: "a start over with a new vault id clears everything").
- **YR-24**: `webauthn-prf` is gone from the keyring's methods; `validateKeyring` requires a KDF on every wrap.

## 5. Unlock, and the 14 days

**PRF** (`unlockWithPrf`): the lock epoch, the settings, the store as loadView reads it (sk_prf with the pointer); the
credentials whose wrap is under the current vault key, each checked in full (none: "paused" when one waits, else "ended";
nothing is tried or recorded); the 14 days **enforced here** (`lastPasswordAt` older than 14 days, or more than a day
ahead: "due", no ceremony); one get() with `evalByCredential`; the answer must be one of those asked for, with UV set and a
32-byte PRF output; the unwrap and the key id; the same `finishUnlock` as a password unlock with the epoch read first (a
lock during the OS dialog voids it: "locked"). It never arms the session layer. A failed unwrap records `prf_failed` (not
counted as a wrong password); a cancel records nothing. In a shared profile it works ("asked at every opening", §5.8), the
key in the page's memory only ("lock every time").

**Gate** (`unlockWithGate`): the gate's half of the arming, usable (its 12 hours, the clock, the vault, key and wraps, a gate credential of this vault and key checked in full **whose MAC checks under the parked key**, a solo
profile; else deleted if it is still this arming, "ended", with no OS dialog); one get() with a fresh 32-byte challenge; Sixkey's own check (`src/core/crypto/assertion.ts`): the answering
credential is one asked for, `clientDataJSON` is `webauthn.get` with our challenge and origin and not cross-origin, the RP
ID hash is SHA-256 of `chrome-extension://<id>`, UP and UV are set, and the signature over `authData ‖
SHA-256(clientDataJSON)` checks with the stored key (ES256: DER read strictly; RS256). A failure records `prf_failed`. Then
the arming must still be there (a hard lock, a key change or a removal meanwhile: "ended"), the parked key's id is
checked, and the same `finishUnlock`. The sign counter is not checked: synced passkeys report 0, a check would write
`chrome.storage.local` at every unlock, and the gate guards only a key already in memory.

**The 14 days restart with the master password** (Q3), at most once a day (YR-14): `prf-write.ts` `notePasswordTyped`
(one read of `sk_prf` in the vault lock, a write only when the time is a day old or more, or ahead of the clock). It is
called **by the lock screen's device chunk** after a master-password unlock (the popup's and the side panel's lock screen,
`src/popup/screens/Locked.tsx`; the settings page's unlock bar), never after a recovery key unlock, and not by the service's
`unlockWithPassword` itself. Why: called from the service's password unlock (with the writer loaded lazily) it costs the
popup's counted bundle 153 B more, over the maintainers' allowance (§9). The lock screen loads the device chunk whenever
`sk_prf` offers something (the view's `device`), so every master password typed there notes it. What can be lost is only a
note (a popup closed at once, a chunk that failed to load): Sixkey then asks for the master password sooner, never later,
and the enforcement stays in the service. `test/e2e/prf.spec.ts` holds both halves (a password unlock restarts them; a
recovery key unlock does not).

## 6. Where the ceremony runs

Enrolment: always in the settings tab (§0A.5 item 3). Unlock: in place in the side panel and the settings page; in the
popup's page in place when it is a tab or a window, and in the toolbar popup itself on macOS, where Stage 0 measured that
the popup survives `get()` with all three providers. In the toolbar popup elsewhere (Windows, Linux: unmeasured), the
button opens the popup's page in a small window (`chrome.windows.create`, 360×600, no permission), whose lock screen has
the same focused button; nothing is lost if a popup closes mid-ceremony. Whether this page is the toolbar popup is
`chrome.tabs.getCurrent()` (undefined there), so the e2e suite, which opens the popup's page as a tab, runs it in place.

## 7. Locks (§5.5, the rows this stage adds)

| Event | What it does to the device unlock |
| --- | --- |
| Soft locks (Lock now, the shortcut, idle, screen lock) | the gate's arming stays; a PRF credential is unaffected |
| End quick unlock now (in the PIN box, and the device box for a gate with no PIN) | hard: both halves deleted, `quick_ended` |
| The 5th wrong PIN (OWNER-DECISIONS/17 Q1) | hard: the gate's half ends with the PIN's |
| The last gate credential removed (revision 2) | the gate's half deleted first; the PIN's stays as armed |
| Another credential removed (a PRF one, one of two gates) | nothing: the arming stays |
| The PIN set, changed or removed | the PIN's half only; setting it arms both from now (the master password was typed) |
| Lock mode changed; shared preset or profile | hard (Stage 1's rule): the gate's arming deleted; never armed in a shared profile |
| Any key event or vault key change | hard (Stage 1's `committed()`); PRF wraps paused by the cleanup, gates by their MAC |
| A re-wrap of the keyring (a new password, reset, new recovery key) | the gate's arming no longer usable (`wraps`) |
| Browser restart | the gate's arming gone; a PRF credential still opens Sixkey (within the 14 days) |
| 12 hours after the master password; the clock set back > 1 min | the gate's arming ends (the expiry alarm deletes it) |
| 14 days without the master password | the PRF unlock asks for it ("due") |

## 8. Never lose data

Nothing here deletes, rewrites or locks away vault data; the keyring is untouched (but YR-24's dropped method, which no
keyring ever had). A removed passkey, a reinstalled OS or a moved profile fall back to the master password, and that to the
recovery key. `test/fault/prf-crash.test.ts` kills a page at every write of enrolment (PRF and gate), removal (PRF and
gate), a key rotation with a PRF credential, "turn back on", the last gate's removal beside an armed PIN and the password's note, before and after
each, and checks with a healthy page: a credential is in `sk_prf` whole or not at all; a stored one opens Sixkey; never an
arming without its credential; a removed one never opens anything, now or after the next master password; the PRF unlock
never opens with an older key's wrap; at most one method armed, and after the next master password the stored choice's;
the master password always opens the current vault. What a crash can leave is a passkey in the OS with no credential in
Sixkey (the page died after `create()`): harmless, and the box says where to delete one.

## 9. Budgets: the maintainers' allowances (2026-10-23) and the numbers (bytes, gzip, check-dist's measure)

"Before" is the live tree after the rename (OWNER-DECISIONS/16 Q-C), built the same way; both columns are check-dist's
figures (zh_CN where the page shows text).

| | before | this stage (revision 2; revision 1) | allowance / limit |
| --- | --- | --- | --- |
| popup, gate open | 57,818 | 58,709 (+891; r1 58,605) | +1,200 (OWNER-DECISIONS/17); limit 61,440 (headroom 2,731) |
| popup, gate closed (the store build) | 56,585 | 57,450 (+865; r1 57,335) | 61,440 |
| side panel, gate open / closed | 60,060 / 58,815 | 60,948 / 59,682 (r1 60,848 / 59,562) | 63,488 |
| settings, every part (zh_CN) | 12,097 | 12,106 (+9: secKPrf* rewritten) | +40; limit 12,288 |
| settings, a vault's page (zh_CN) | 11,576 | 11,586 | 12,288 |
| device unlock text (lazy, zh_CN / en) | | 1,506 / 1,234 (r1 1,487 / 1,223) | 1,600 (was 1,500; at most 1,700) |
| a vault's page with every lazy catalog (zh_CN) | 12,857 (shares only) | 13,830 | 15,360 |

Revision 2 added 92 B to the popup's counted bundle (gate open; revision 3 12 B more, G3's arming of the gate alone): the gate's key id and public key in the main chunk's
`gateCreds` and `pausedCreds` (S1, S2), and both halves armed and shown at once (OWNER-DECISIONS/17 Q1); the MAC itself,
"Also after a restart", the one touch after a key change and "End quick unlock" in the box are lazy. The device text
grew by 19 B (F2, Q3, Q4, less the session choice's two strings); "End quick unlock" and "Cancel" reuse the settings
page's words, so its parts did not grow. With the plugin platform's W1a (about +1,017 B of lazy text on a vault's page,
by its own measure) the page with every lazy catalog would be about 14,847 B by adding the two; the delta review, counting W1a's change to settings-core too, puts the spare at about 380–400 B, still over the 300 B asked for.

The popup's counted bundle grows by what its main chunk needs: `sk_prf`'s shape from the pointer's read, the lock screen's
device view, arming the gate, the store's key-change step, `devicePlan`/`gateFirst`/`vkOf` for the lazy unlock (+787 B in
revision 1; 40 B more in revision 2, above).
Everything else is lazy: the WebAuthn adapter, the PRF crypto, the assertion check, the full field check, the writer, the
unlock flows, the button and their text (`assets/DeviceUnlock-*.js`, `assets/device-locale-<lang>-*.js`), and the settings
box (`assets/DeviceBox-*.js`). What was measured on the way, gate open: the first version +1,345 B; a strict parser in the
main chunk 308 B of it, the general writer and the password note 103 B, the per-credential shape check 46 B; the service
calling the lazy note itself would add 153 B again (§5).

**SHAMIR-NOTES §7 again, measured.** The first version of the lazy chunk imported the main chunk's modules (`bytes.ts`,
`kdf.ts`, `vk.ts`, `pin.ts`, `prf-record.ts`, `service-error.ts`, `types.ts`): the bundler regrouped the popup's chunks and
the counted bundle grew by a further 822 B (gate closed; 97 B open). So `device-unlock.ts`, `prf.ts`, `assertion.ts`,
`prf-check.ts`, `prf-write.ts` and `platform/webauthn.ts` import nothing of the main chunk (only `crypto-error.ts`, a leaf,
and each other); the rules they apply are read through the service (`devicePlan`, `quickUsable`, `dropIfSame`, `vkOf`),
`prf.ts` calls WebCrypto's HKDF and AES-GCM itself with its own base64, and `prf-write.ts` restates the key's name;
`test/unit/prf-source-rules.test.ts` holds these imports. Building with no device chunk at all changes the counted bundle by
8 B: the lazy chunks cost nothing up front.

The catalog is `catalogs/device-<lang>.json` (`scripts/i18n/device.py` DEVICE_EN / DEVICE_ZH; messages.py, build.mjs and
check-dist as the shares' are), 38 keys, **budget 1,500 B, the allowance, with 13 B left**: the copy was cut to fit (every
line as short as it can be and still say what it protects; the settings page's own words where it has them:
`passwordLabel`, `unlockToManage`, `pinNeedsPassword`). The page with every lazy catalog in (the shares' and this one) is
held to 15,360 B in both messages.py (DEVICE_VIEW) and check-dist.

**Reads** (`test/unit/prf-read-budget.test.ts`, the popup's real wiring): `sk_prf` comes with the pointer's first get, never
on a get of its own; the lock screen stays within the open budget; a device unlock reads no more of `chrome.storage.local`
than a password unlock and writes nothing of `sk_prf`; a password unlock with a credential reads exactly what it reads
without one (7, with the lock screen); the lock screen's note after it is one get of `sk_prf`, and a set at most once a day
(YR-14's explicit exception). The store's key-change step reads the keyring only when there is a record (the degraded-mirror
unlock stays at its 10).

## 10. The dev build's fixed extension ID (§0A.1 item 5, §8 "Release-order constraints")

Passkeys are bound to `chrome-extension://<id>`. `manifest.dev.json` now has a `key` (an RSA-2048 public key; the private
key was not kept: an unpacked copy needs none), so the dev build's ID is fixed, **`pgnlbjikdnniepfeijffpefifnojjege`**,
and a developer's enrolments survive reinstalls and moved folders. check-dist allows `key` in the dev build only and checks
that it gives that ID; the store and e2e builds may not carry one. **The store ID and the prod manifest are untouched**
(OWNER-DECISIONS/11): the store ID must be final before this feature reaches users, and must never change without a
migration plan (a change loses no data but strands every enrolment).

**The switch itself changes a dev install's ID (PRF-FU).** A dev build from before this stage had no `key`: its ID came
from the folder it was loaded from. `npm run build:dev` writes into `extension/dist-dev/`, so an everyday install loaded
from there takes the fixed ID at its next reload or browser restart, and Sixkey looks empty: the data stays under the
old ID (whether Chrome keeps an extension's storage once its unpacked ID changed is unverified: assume it does not).
OWNER-CHECKLIST item 30's preparation says what to do first: export an encrypted backup from the install in use; better,
test Touch ID in a separate Chrome profile from another folder; to get back, rebuild the earlier version into the same
folder (the path-derived ID returns) or restore the backup. The prod build loaded unpacked (`dist/`, no `key`) has the
same rule without the switch: its ID is the folder's, unchanged by rebuilding in place, changed by another folder. The
store build has the store's ID.

## 11. Deviations from QUICK-UNLOCK.md

1. **"Ways to unlock" is two boxes**, the Stage 1 PIN box and a new Touch ID box beside it, not one box that also lists the
   master password and recovery key (they stay in Password & recovery). The session-method choice is in the new box.
2. **No auto-start in the popup** (§5.4 "starts by itself"): a focused button instead; the no-interaction `get()` is
   unmeasured (§1.6). Owner question 2.
3. **The small window** is the popup's own page (no `?mode=window`): whether a page is the toolbar popup is
   `chrome.tabs.getCurrent()`; the window's lock screen has the same focused button rather than starting by itself.
4. **No rename of a credential**: the name is the platform's word at enrolment, with the date added beside it.
5. **The PIN and the gate armed at once** (OWNER-DECISIONS/17 Q1; §5.1 item 3 says one at a time): one `sk_quick` record,
   the same hours, either opens; whatever ends one ends both, the 5th wrong PIN too. No session-method choice, no
   `session` field (revision 1 had both).
6. **`provider`** in `sk_prf`, from the AAGUID, for the removal text (§5.6 names the places; Sixkey cannot otherwise tell).
7. **The 14 days restart only with the master password** (and enrolment, "turn back on"), noted by the lock screen's device
   chunk rather than inside the service's password unlock (§5: the budget); not with a recovery key unlock; `verifyPassword`
   stays write-free. Owner question 3.
8. **"Turn back on" asks for the master password** (YUBIKEY §1.2.5 says one touch), but right after a key change made on
   this page, where it was just typed: one touch there (OWNER-DECISIONS/17 Q3).
9. **Security keys**: not enrolled in this stage; a cross-platform answer is refused ("refused"), not classed
   `security-key` (§7.2's "usb" row). Stage 4.
10. **The sign counter** is not checked (§5).
11. **A failed gate check records `prf_failed`** too (§5.4 names it for a failed unwrap only): something answered that did
    not pass, which the security record should show. Neither is a wrong password.
12. **Removal ends the gate's half of the arming only with the last gate credential**, not the page's session (as Stage
    1's PIN removal), nor the PIN's half (revision 2): the settings page stays unlocked.
13. **The copy is shorter than §6.5's** (the 1,500 B allowance): the same substance for quickSyncedNotice, quickOnGate,
    quickOnPrf, quickOnPrfSynced, prfSyncedRefused and prfRemoved; "Turned on." for the enrolment's answer (the list says
    what it can do); quickNothingLost and "Not working? Remove" in one line; quickSharedOff and the "after a lock it opens
    again" half of quickOnGate left out.
14. **The two readings of `sk_prf`** (§2): a shape check in the popup's main chunk, the full check on the lazy side, which
    drops what is unusable and stores the record healed at its next write.
15. **A gate credential carries a MAC under the vault key** (revision 2, REVIEW S1; §5.2 has none): a planted one is
    refused, and a key change pauses a gate until it is turned back on, as it does a PRF credential (§5.2 kept gates
    across key changes, since they hold no key material).
16. **"Also after a restart" for a synced gate** (OWNER-DECISIONS/17 Q4; not in the design): the same credential made a
    PRF one in place, after the synced notice, with no new passkey; prfSyncedRefused points to it.

## 12. Windows: what is unmeasured (§0A "Still unmeasured", §11.1 items 5, 7, 9)

The Windows half is built to the same rules and classified by what the authenticator returns, but nothing of it has run on
a Windows PC: whether Windows Hello accepts the extension-origin RP ID; PRF at `create()` and `get()` and on which builds
(KB5077181); the BE flag of a Windows Hello passkey (expected 0: then a PRF one is persistent without the opt-in); RS256
(supported: tested with the fake authenticator); whether the credential must be resident (requested resident, YR-28);
whether the toolbar popup survives the dialog (assumed not: the small window); the dialog's requester name. OWNER-CHECKLIST
item 35 lists the checks. Linux and ChromeOS: no platform authenticator is expected; the box then says the PIN still works.

## 13. Tests, mutants, runs

### 13.1 Tests

- `test/unit/prf-crypto.test.ts` (16): the wrap is exactly HKDF-SHA256 (empty salt, the label) and AES-256-GCM with
  §5.2's AAD, with a known answer in pinned bytes; another PRF output, vault, key id, credential, IV or a tampered byte
  never opens it, and the key id is checked after the unwrap; the salt (32 fresh bytes); the popup's shape check and
  prf-check's full one (every field, the usable credentials kept); which credentials an unlock may ask for; the 14 days at
  their edges (exactly 14 days counts, a millisecond more does not; a day ahead counts, more does not); the note at most
  once a day; the assertion check: ES256 (DER) and RS256 pass, and each clause refuses on its own (UV, UP, challenge,
  origin, type, crossOrigin, RP ID hash, signature, key, algorithm); client data, the RP ID hash, the AAGUID; DER read
  strictly; the gate's MAC against node:crypto (HKDF and HMAC), and each field it binds (revision 2).
- `test/unit/prf-service.test.ts` (64): §3's table row by row (PRF or gate, synced or not, the opt-in; RS256; every
  refusal saves nothing; a cancel records nothing; the same passkey twice; the master password first; a Phase 0 vault; a
  shared profile; at most ten; a key change during the ceremony); the persistent unlock (after a restart, the 14 days
  enforced in the service, the note, prf_failed, a cancel, a lock during the dialog, a key change pausing it and "turn
  back on", a new password keeping it, a shared profile, never a way past the master password for exports and key
  changes); the gate (a soft lock keeps it, each clause of the check, a credential not asked for, a restart, its 12 hours
  and the clock, every hard lock, never in a shared profile, an arming ended or edited during the dialog); one session
  method at a time; removal, a new vault, not vault data; an unusable credential; nothing secret on disk or in a log; and
  every write of `sk_prf` one critical section under the vault lock (§7.3 item 16: with the lock held by another page, the
  key change's step and the lazy writer write nothing, then both land, no update lost). Revision 2 added: a planted gate
  credential of an authenticator that answers is never asked for; a key change pauses a gate (the PIN armed instead,
  "paused"), and turning it back on refuses a wrong id or signature, then opens it; "turn back on" refuses an answer
  without UV or for another credential; the PRF output zeroed; with the gate the method, no "PIN needs the master
  password" after a restart; a gate without a public key is none; "End quick unlock" in the device box. With
  OWNER-DECISIONS/17: the PIN and the gate armed in one record by the master password, either opening, neither moving
  the hours, both ending at their end, at the 5th wrong PIN, End quick unlock now and a key change; each half its own (a
  PIN typed at a gate-only arming, a gate unusable beside the PIN, the gate's half taken away during the dialog); setting
  and removing the PIN; the last gate's removal leaving the PIN's half as armed; one touch right after this page's key
  change (not another page's, not after 10 minutes, not for another key); "Also after a restart" in place (its
  refusals, no new passkey, the last gate's half going) and only for a synced gate of Sixkey's own in a solo profile.
- `test/unit/prf-read-budget.test.ts` (4) and `test/fault/prf-crash.test.ts` (8): §9's reads and §8's crash points.
- `test/unit/prf-source-rules.test.ts` (13): `navigator.credentials` in `platform/webauthn.ts` only; `results.first`,
  never `prf.enabled`; the lazy modules' imports; `import()` only; nothing secret logged; no key material in a gate;
  `verifyPassword` knows nothing of the device unlock; YR-24; the manifests' keys; what the popup can reach;
  `userVerification: "required"` in both ceremonies; the synced refusal's words (revision 2).
- `test/unit/prf-check-dist.test.ts` (19, with its cases): against real builds, check-dist fails on the device text
  over its limit, a text chunk missing or not the generated file, a device key that is a full catalog's, a vault's page
  with every lazy catalog over 15,360 B, two lock-screen chunks, the lock screen's chunk or the box in the popup's static
  graph, a WebAuthn call there, the dev build with another key's ID, a key in the store build; messages.py refuses a
  device key of another catalog or one added twice, and writes the catalogs as the tree has them.
- `test/e2e/prf.spec.ts` (16, Chromium's virtual authenticator): a PRF passkey (enrolled, opens Sixkey from the lock
  screen, also after a restart); a gate (until the browser closes; after a restart the master password, which arms it
  again); a failed user verification; an assertion without UV refused by Sixkey's own check; a synced passkey with and
  without the opt-in; a passkey deleted in the OS; a key change and "turn back on"; the shared preset; the settings page's
  unlock bar; the 14 days restarted by the master password on the lock screen, not by the recovery key; "End quick
  unlock" in the device box for a gate with no PIN; a device unlock shows the wrong-password notice and never acks it
  (revision 2); the PIN's field and the Touch ID button on one lock screen, either opening; one touch after the key
  change; "Also after a restart" after the notice (OWNER-DECISIONS/17).
- Updated, for the second session method and the new box: `quick-source-rules`, `m2-source-rules`, `budget-split`,
  `contract-vectors`, `sync-crypto-hygiene`, `quick-pin-service`, `quick-pin-races`, `test/fault/quick-pin-crash`
  (Stage 1's tests narrowed to `QuickPin` where they read `sk_quick`); after the first full run (8 failures, all in
  rules and mocks that had not been told of the device unlock): `autofill-pre-source-rules` (`options/DeviceBox.tsx`
  listed among the senders, for its `sk-reschedule-autolock` after an enrolment arms the gate, and among the
  `storage.onChanged` listeners, as `PinBox.tsx`), `own-password-pages-dom` (the unlock bar's mock service answers
  `openView`, which the bar now asks for the device view), `own-password` (the bar's PIN line: not while the gate is the
  session method), `sidepanel-mode` (Locked.tsx's second `focus()`, after the user's own Touch ID attempt failed or was
  cancelled: to the master password's field only, never the PIN's, and in the side panel only while it has the focus,
  as the first: revision 2, REVIEW F1, the rule strengthened back to "both sites guarded"). Revision 2 also:
  `contract-vectors` (the gate MAC's label and tag among the local-only ones), `m2-source-rules` (the device unlock's
  steps in the element-access rule, S6), `security-notice` (any other way in than the master password never acks the
  notice), the fake authenticator (`tamperCreate`, `wrongId`; no `transports`).

### 13.2 Mutants

130 hand-made unit mutants since revision 3 (one text edit of one file each; `mutants.py`, delivered with the patch) against
the five test files above (the PIN's tests too where Stage 1's rules are touched, prf-check-dist for the build's), and 2 e2e mutants
(`e2e-mutants.py`: the lock screen's note of the master password). The groups: the wrap's label, tag, AAD, salt and key
id check (K1–K8); the salts asked for (S1–S4); the 14 days and the note (D1–D10); the assertion check and its use
(A1–A19); the full check on the lazy side and the healing (V1–V6); the classification (C1–C6); the shared profile
(H1–H3); hard locks and invalidation (L1–L15); the unlock's session start and records (U1–U6); write orders, the read
budget and the vault lock (W1–W5); YR-24, the dev key, `prf.enabled` (Y1–Y4). QUICK-UNLOCK §7.3's Stage 2 targets: item
6 is K3–K5, 7 is K7, 9 is U1, 11 is A1–A11, 12 is Y4, 13 is C2, 14 is D2, 16 is W4–W5; items 1–4, 8, 10 and 15 are Stage
1's (QUICK-PIN-NOTES.md). Item 5 at enrolment (a device-key vault refused) is checked twice, by the box's own check and
by `verifyPassword`, with the same answer (`not_protected`) and nothing read or written in between: removing either is
an equivalent mutant, so none is listed.

**Result, revision 3, on the tree as delivered: 130 of 130 unit mutants killed, every one by a failed assertion (129 in
the full run; R6, which survived there, on a fresh copy once a test told it apart: a store unreadable for a moment
during a gate unlock; V4, H2, H3 and L1 again there too, whose first kill also met a hook timeout under the machine's
load).** Revision 3 added G2m, G3a, G3b and Q3f (REVIEW-r2 G2, G3, G5; Q3f is the review's R2M16), and R1, R2 were
rewritten for the new arming code. Revision 2 with OWNER-DECISIONS/17 had 126 of 126 killed in one full run. Each kill
was read in its log: a failed `expect` (an assertion error), not only a throw or a timeout. E1 and E2: killed, at
`prf.spec.ts`'s lines that check the 14 days' note. Before the owner's answers, revision 2's 113 were all killed the
same way (110 in the full run, V2, R3 and R4 on a fresh copy once their tests told them apart); revision 1's figure was
86 of 86.

Revision 2's mutants: the 86 of revision 1 with nine rewritten for the new code (V2, V6, H2, H3, L1, L2, L8, L14, W1)
and L9 dropped (equivalent now: a gate is asked for only when its MAC, which names the current key, checks under the
parked key, so an edited parked key never reaches that check, which the code keeps as a second one); the gate's MAC
(G1–G7: not checked; each field it binds; the label; the tag), the key change pausing a gate (G8, G9), the MAC written
at enrolment (G10), "turn back on" for a gate (G11, G12), a gate is a public key (G13), "End quick unlock" in the box
(E1u), the side panel's focus (F1), the synced answer's words (F2), and the review's six survivors (RM08, RM19, RM20,
RM35, RM39, RM43). With OWNER-DECISIONS/17, the session choice's mutants became the both-at-once model's: L1, L2, L5,
L10–L14, W1, D10, H2, H3 rewritten for its code; R1–R7 (the master password arming the PIN without the gate; no PIN, no
gate; any removal ending the gate's half; the 5th wrong PIN leaving it; the gate's half gone during the dialog still
opening; an unusable gate half dropping the PIN's; the box not seeing the gate beside the PIN); N1 (a PIN unlock
extending the hours); Q3a–Q3e (the one touch anywhere, for another key, at any time, never noted, counting from the
touch); Q4a–Q4f ("Also after a restart" for a planted gate, without the assertion check, in a shared profile, for a gate
that does not sync, leaving the last gate's half armed, without a PRF output).

Revision 1, what its first full run (2026-10-23, after the restructure of §9) found, and what was done: 76 of 87 killed. D8 was not
a mutant (its edit did not parse) and was rewritten; W6 (item 5 above) was dropped as equivalent; S3 had been killed
only by a ReferenceError (its edit called a decoder that file does not import) and now decodes the old salt itself; K6
is a non-zero salt (32 zero bytes are the empty HKDF salt: equivalent). Nine survived for want of a test, each now
written: "turn back on" restarts the 14 days (D10); a DER byte after the two integers inside the SEQUENCE (A10); two PRF
credentials, the second answering (A15); a verification answer naming another credential (A16, the fake's `wrongId`);
the creation's own check clause by clause while the verification get answers truly (A17, A19, the fake's
`tamperCreate`); a credential the popup's shape check lets through but `credOk` does not is never asked for, PRF and
gate (V1, V2); a gate arming whose credential is gone is not offered (L5). Three were caught only by a throw (C1, L9,
L12): their tests now assert on the promise (`resolves`), so a throw fails an assertion. §7.3 item 16 had no mutant and
no test: W4, W5 and the test of the vault lock were added.

### 13.3 Runs (2026-10-23, the tree as delivered)

Revision 3 (the delta review's G1–G5):

- Full unit (`vitest run --maxWorkers=2`): 248 files, 3,709 passed, 4 expected to fail, 1 skipped.
- e2e, in the port-moved copy, after prod, `--e2e` and `--dev` builds with check-dist: the same ten specs, 62 passed, 1
  skipped; `prf.spec.ts` 16 of 16.
- Builds with check-dist: prod, `--e2e`, `--dev` and a gate-open one; `typecheck`; `format:check`; `messages.py`.
- The patch applies to the live tree with `patch -p1 -E --dry-run`, clean.

Revision 2, with OWNER-DECISIONS/17: full unit 248 files, 3,706 passed; the ten specs 61 passed, 1 skipped.

Revision 1:

- Full unit: 248 files, 3,688 passed, 4 expected to fail, 1 skipped.
- Full e2e, in a copy with the API port moved off 8787 (in `src`, `scripts`, `test`, the manifests and the Playwright
  configs, so that whatever listens on 127.0.0.1:8787 is never touched; the patch carries no port change): 343 e2e and
  12 regression specs passed, 1 skipped (`prf.spec.ts`: 10 of them); the copy's path also matched the main config's
  pattern for the 12 sync specs, which passed there too.
- e2e:sync (same copy, the real API server): 12 passed.

## 14. Questions for the owner: decided (OWNER-DECISIONS/17, 2026-10-23, all as recommended)

1. **The gate and the PIN at once?** Yes: both armed by the master password, either opens (§4, §11 item 5).
2. **Start Touch ID by itself when the popup opens?** Measure first: OWNER-CHECKLIST item 30 says what to try and what to
   report (does a `get()` with no interaction since the popup opened work; does the real toolbar popup survive the
   dialog; the same for the Windows small window). Not built in this revision.
3. **"Turn back on" with the master password?** Yes, but one touch right after a key change made on this page (§4).
4. **A synced gate made persistent in one step?** Yes: "Also after a restart" (§1, §4).
5. **What restarts the 14 days; the synced opt-in in a shared profile?** The defaults: the master password only, not a
   recovery key; never offered in a shared profile.

## 15. Revision 2: the independent review (2026-10-23, "passed with changes")

The independent review found no blocker. What was changed, item by item; the maintainers
decided S1(b), S2, S3/O7 and S9 as engineering, UX first, and sent O1, O2, O4, O6 and O8 to the owner (OWNER-DECISIONS/17).

- **F1, the side panel's focus.** The second `focus()` of the lock screen (after the user's own Touch ID attempt failed
  or was cancelled) is guarded as the first: `now.current !== "pin" && (!surface.panel || document.hasFocus())`. A
  ceremony that ends after the user went back to the web page (a click there dismisses Chrome's passkey prompt) no
  longer pulls their next keys into Sixkey's field. `sidepanel-mode` is the rule again: both sites guarded.
- **F2, the synced passkey's answer.** Revision 1 said "add it again with the box ticked", which the provider refuses
  (`excludeCredentials`: the same passkey twice), so it led to "Added already.". Now: "… For restarts too, choose “Also
  after a restart” beside it." / "……想重启后也能用，点它旁边的“重启后也可以”。", the in-place conversion of
  OWNER-DECISIONS/17 Q4 (§4). A service test holds the flow (added again with the box ticked: "exists"; converted in
  place: "prf", synced, the same credential), a source rule the words in the fragment and the catalogs. The device text
  is 1,506 B (zh_CN) of its 1,600.
- **F3, the security documents.** local-vault.md: a copy of the profile is as strong as the master password whether or
  not a persistent passkey is added (it still guesses the password offline; OWNER-DECISIONS/15 item 4); removing a
  passkey is no hard lock (the last gate's removal ends the gate's quick unlock, the page stays unlocked); Windows Hello
  is marked unverified on real hardware there, in PRIVACY.md and in ARCHITECTURE.md.
- **F4 and S5, six survivors of the review's mutants, each now killed by an assertion.** RM19 and RM20 ("turn back on"
  without UV, or answered for another credential: refused, nothing written); RM43 (with the gate the method, the lock
  screen never says the PIN needs the master password, also after a restart); RM08 (the PRF output zeroed once used,
  opened or not); RM35 (a device unlock shows the wrong-password notice and never acks it: `prf.spec.ts`, and a rule in
  `security-notice`); RM39 (`userVerification: "required"` in both ceremonies, a rule in `prf-source-rules`).
- **S1(b), the gate's MAC** (§2): a credential planted in the profile's storage is never asked for; a gate is paused by
  a key change and turned back on with the master password and one touch, as a PRF credential (the same line, the same
  button). local-vault.md's "Limits" says what writing the profile can still do (list a credential, move the 14 days).
- **S2**: the main chunk's gates are only those with a public key stored as a string.
- **S3 / O7, the re-arm**, rebuilt for OWNER-DECISIONS/17 Q1 (§4, §7): there is no switch of method any more (both are
  armed); a removal takes the gate's half away only with the last gate credential, and the PIN's half stays as it was
  armed, so nothing needs arming again and the 12 hours never grow.
- **OWNER-DECISIONS/17** (the owner's answers, folded into this revision): Q1 the PIN and the gate at once (one record,
  the same hours, either opens; the 5th wrong PIN, a hard lock, a restart, a key change end both; the session choice and
  its field gone); Q3 one touch right after a key change on this page, the master password everywhere else; Q4 "Also
  after a restart" for a synced gate; Q2 (starting by itself) to be measured first (OWNER-CHECKLIST item 30). The device
  text's budget rose from 1,500 to 1,600 B (of the 1,700 allowed) for their words; the popup's allowance to +1,200 B.
- **S4, a known limit, documented (the maintainers' decision after REVIEW-r2).** The check after `finishUnlock` that
  the vault key is still the vault's costs two reads of `chrome.storage.local` (the pointer and the slot): a device
  unlock would read 9, over `prf-read-budget`'s "no more than a password unlock" (7) and the unlock gate's 8; the read
  budget is not raised. The race (another page changes the key during the OS dialog; the old key is written back into
  the session, which can open nothing and write nothing, until the next lock) is the password unlock's too. Future
  work, for both unlock paths: let the session's `get()` take the settings the unlock has already read, so a check
  that reads `sk_session` before the end (the reviewer's probe: another page's key there, "locked") costs no read of
  `chrome.storage.local` at all.
- **S6**: `m2-source-rules`' element-access rule names the device unlock's steps too (`prfs`, `also`, `finishUnlock`,
  `devicePlan`, `quickUsable`, `dropIfSame`, `vkOf`).
- **S7**: PRIVACY.md says what the passkey provider keeps (the name "Sixkey", "Sixkey unlock · <date>", a random user
  ID, the extension's address; a synced one in the Apple or Google account).
- **S8**: `sender-policy.ts`' list of `sk-reschedule-autolock`'s senders names `options/DeviceBox.tsx`.
- **S9**: "End quick unlock and lock" in the device box too, for a gate with no PIN beside it (the PIN box's words and
  step: no new text).
- **S10**: the unused `BS` flag and `Created.transports` are gone.

What the review's other findings asked for is in §11 and §14 as before; the owner's questions it added (O1–O10) are the
maintainers' OWNER-DECISIONS/17.

### 15.1 Revision 3: the delta review (REVIEW-r2, "passed with changes")

- **G1**: local-vault.md says that with a PIN set up beside the gate either opens (the PIN's 5 tries too), that
  `sk_quick` then also holds the vault key unwrapped for the gate's half, and what a planted gate credential can still
  do (a button that disappears at its first press; each master password parks the key for the gate's half); §15's F2
  item says what revision 2 shows.
- **G2**: the gate unlock, finding no gate credential that can answer for the gate's half (none, or none of Sixkey's own
  under this key), drops that half: the lock screen offers no button that can never open; the PIN's half stays.
- **G3**: a PIN record whose ciphertext does not open never stops the gate from being armed: the master password, an
  enrolment and "turn back on" then arm the gate alone ("PIN not armed" in the diagnostics).
- **G4**: right after a key change, each paused credential has its own "Turn back on" and its own answer (one touch
  each), instead of one button for all that showed only the last answer.
- **G5**: a key change's note dated after now (the clock moved back) is no proof for the one touch.
- S4 is the known limit above.

### 15.2 Follow-up (PRF-FU, after REVIEW-r3)

- **H1**: the review's probe of G2's "armed anew meanwhile" is a test of the suite (prf-service.test.ts): another page's
  arming made during the gate unlock's look keeps its gate half. It kills R3M01 and R3M04.
- **H2**: the gate armed alone beside a PIN set up (its record did not open: G3) no longer shows "the PIN needs the
  master password once" on the lock screen, which a master password would not fix (service-core.ts openView; mutant
  H2m). Nothing is said about that PIN; Settings › Security still lists it, to be set again. The condition is the gate
  armed without the PIN, so it also hides the line in two cases where a master password would arm the PIN: a page closed
  between setPin's clearPinArming and its new arming, or between removePin's two steps. Both are a closed page in a
  window of a few milliseconds; the lock screen then offers Touch ID and the master password, which arms both. Accepted
  (the maintainers, 2026-10-24) over a new field in sk_quick to tell the cases apart.
- **The dev build's ID**: §10's warning, and OWNER-CHECKLIST item 30's preparation.

