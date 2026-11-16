# Sixkey quick unlock: design proposal (QUICK-UNLOCK)

> **Approved design; Stages 1 and 2 are built.** Stage 1 (the session PIN and the quick lock) is merged in `extension/`
> (`docs/design/notes/QUICK-PIN-NOTES.md`). Stage 2 (device unlock: PRF and the gate, Touch ID / Windows Hello) is built
> and reviewed (2026-10-23: passed with changes, applied as its revision 2, with the owner's answers of
> OWNER-DECISIONS/17: the PIN and the gate at once, one touch after a key change, a synced gate made persistent in
> place); what was built, and where it departs from this text, is in `docs/design/notes/PRF-NOTES.md`. The Windows half
> is unmeasured on real hardware. The Stage 0 probe is a separate dev-only extension in `tools/webauthn-probe/`. Where
> another document has to change, §10 lists what; the dated notes recording the owner's decisions have been added there.
> The text below is the design as approved on 2026-10-19 and is otherwise unchanged.
>
> **2026-10-27, OWNER-DECISIONS/20:** the owner amended §0.3's rule for the PIN ("解锁还是比较麻烦，因为密码太长了"): a
> switch "Also after a restart" (Settings › Security › PIN quick unlock, **off by default**, the master password to turn
> it on; any PIN the policy takes, 4 to 8 digits, since the owner's 2026-10-30 note dropped the 6-digit floor it had)
> makes option B (§4.2) available as an opt-in, with its cost said in the owner's words before it is turned on. Built,
> reviewed in four rounds (the last passed) and merged on 2026-10-28: `docs/design/notes/PIN-RESTART-NOTES.md` (§16,
> §17). The analysis of §1.7 and §4.2 is unchanged and is what that switch's notice says; the rule still holds whenever
> the switch is off.
>
> **2026-10-30, OWNER-DECISIONS/20's second note (supersedes the paragraph above and §0.3's rule for the PIN):** the
> owner kept only one limit for the PIN, 5 wrong tries in a row ("最多就是加一个 pin 码重试错误的限制"). The switch is
> gone: every PIN set has its record on disk (option B, §4.2), so the PIN opens Sixkey after any lock, also after a
> browser restart or an extension reload, with no 12 hours, no browser-close limit and no 14 days; a weak PIN is only
> warned about; the cost is said where the PIN is set. The session PIN of §5 (`sk_quick` under the PIN) is no longer
> built: `sk_quick` holds the Touch ID / Windows Hello gate's arming only. A key change still pauses the record, and a
> shared profile still has no PIN. `docs/design/notes/PIN-RESTART-NOTES.md` §18 has what was built.

Date: 2026-10-19. Status: **approved design, 2026-10-19 (owner decisions in §0.5). Stage 0 in progress: Mac runs 1–3
done (Google Password Manager, iCloud Keychain, Chrome profile; §0A); blob tests, the restart test and Windows pending.
Stage 1 (session PIN and quick lock, the owner's first priority) is built and merged; its notes are
`docs/design/notes/QUICK-PIN-NOTES.md`. Stage 2 (device unlock with PRF and the gate) is built: PRF-NOTES.md.** Stage 1 had an
internal AI-model review ([`QUICKPIN-REVIEW.md`](../../audit/internal-reviews/QUICKPIN-REVIEW.md)); this design has not
been reviewed by a third party.

Markers, as in `YUBIKEY-DESIGN.md`: **[verified]** I read the primary source (this repository's code, or the Chromium
source on GitHub `main`, which is not necessarily the stable binary); **[transcribed]** taken from another document of
this repository or a vendor page I fetched but did not test (vendor claims stay vendor claims); **[inferred]** my
reasoning; **[estimate]** a number nobody measured; **[unverified]** a claim I could not check. Every [unverified] claim
is collected in §11.

---

## 0. Summary and recommendation (read this first)

### 0.1 What the owner asked

"Opening a TOTP app should be instant: a complex master password **or** a short PIN, like Windows Hello." Clarified
later: the main mechanism is **the computer's own sign-in, Touch ID on a MacBook and Windows Hello on Windows**, the way
Chrome's password manager asks for the OS password before it shows a saved password. A Sixkey PIN is only the
**fallback**, for a computer that has neither or a user who declines. The master password stays the root and the way back.

### 0.2 Two corrections to the brief

1. **New vaults have no key stored beside the data.** Since H1 every new vault gets its master password and recovery
   code before anything is written (`VaultService.prepareKeys`, `service.ts:401` [verified]). Only Phase 0 vaults still
   carry the device key, which is what the "No master password yet" card is about. So a design "equal to today's
   no-master-password level" is a **downgrade for every vault made since H1**, not a step sideways. It would also bring
   back the leftover-bytes problem `docs/security/local-vault.md` documents ("Only partly" row; LevelDB keeps
   overwritten values until it compacts).
2. **This request reopens four earlier decisions.**
   - SYNC-DESIGN §13 F25: "记住我 / PIN" is a non-goal, because it "puts the device key back into the profile, and vendors
     copy profiles" (decided Q4).
   - SYNC-DESIGN §13 rejects a per-device persistent VK wrap. §2.1 explains why: a non-extractable key only stops
     JavaScript from exporting it, and the profile still holds it.
   - `ux-study.md` §2.6 already rejected the PIN on the 67-second brute-force figure. §12 Q4 sent unlock friction to the
     Phase 3 PRF unlock; the owner never answered Q4 directly, and it is marked "can be overturned at any time".
   - `YUBIKEY-DESIGN.md` D25 / Q2 (owner-decided) allows **only security keys plugged into the computer**, enforced in
     code by three checks: BE flag set, `hybrid`/`internal` transport, attachment not `cross-platform`. Each check
     rejects Windows Hello and Touch ID, so this proposal needs D25 amended (§9 Q2).

   This proposal does **not** dispute the reason behind F25. A PIN or gate whose key is stored on disk stays rejected,
   for exactly that reason. What F25 never analysed is narrower: an unlock that exists **only in memory** and ends when the
   browser restarts. That, plus a hardware-bound unlock, is what this proposal recommends.

### 0.3 The one rule that decides everything

> **A quick unlock may survive a browser restart only when its key is held by hardware that rate-limits guesses (the
> TPM behind Windows Hello, the Secure Enclave or the passkey provider behind Touch ID, a security key). Everything
> else lives in memory only and ends with the browser.**

Why: anything Sixkey writes to the profile is in every copy of the profile (A3: vendor sync, cloned profiles, backups,
a stolen disk). A copy can be attacked offline, with no attempt limit. A short PIN has about 20 bits of entropy. The
master password floor was 50 bits when this was written (since 2026-10-22 it is a warning, not a floor: §1.7's note).
That is a factor of about 10⁹, and no key-derivation function a browser can afford
closes it (§1.7). A WebAuthn assertion **without** PRF is only a yes/no answer (a gate). It gives no key, so the vault
key would have to sit beside the data.

> **Dated note (2026-10-27, OWNER-DECISIONS/20).** The owner has accepted that price for the PIN, as an opt-in: with
> "Also after a restart" turned on, a copy of the profile is only as strong as the PIN (4 to 8 digits since 2026-10-30;
> a few seconds for every 4-digit PIN, about 5 minutes for every 6-digit one and 8 hours for every 8-digit one on one GPU
> at the master password's PBKDF2 count, PIN-RESTART-NOTES.md §2.4). Off, the rule above holds as written.
> **Since 2026-10-30 (OWNER-DECISIONS/20, second note) it is no longer an opt-in:** every PIN has the record, so with a
> PIN set a copy of the profile is only as strong as the PIN; someone at the keyboard still gets 5 tries in a row.

### 0.4 Recommendation

Three ways in, from strongest to most convenient. The master password and the recovery key stay the root:

| Level | What opens Sixkey | Survives browser restart | Honest label |
|---|---|---|---|
| **Root** (unchanged) | master password; recovery key | yes | as today |
| **Device unlock with a key** (PRF) | Touch ID / Windows Hello / the OS password the OS offers instead; the authenticator returns a PRF secret that unwraps the vault key | **yes** | "A copy of this browser profile is no use without this computer's sign-in." A synced passkey only after the user opts in (off by default, Q2): "…or without your Apple / Google / password-manager account." |
| **Session quick unlock** (memory only) | the Sixkey PIN (the owner's first priority, 2026-10-19), **or** Touch ID / Windows Hello without PRF (gate) | **no**: it ends at browser restart, at most 12 h after the master password was typed, and after 5 wrong PINs | "Stops people at your computer. Does not stop programs on it, or anyone who opens the browser's developer tools." |

The design is **hybrid by construction**. At enrolment Sixkey asks the authenticator for a PRF result and checks whether
one came back. If it did, the device unlock wraps the vault key (persistent). If it did not, the same Touch ID / Windows
Hello is offered as a session gate (memory only), and the screen says so. The PIN uses the same session machinery.
Nothing persistent is ever protected by a PIN or by a gate.

**What to build first** (§8). **Reordered 2026-10-19 on the owner's priority:** "The PIN is the most basic feature:
whoever wants to use a TOTP extension quickly unlocks with a PIN and locks again quickly; that is the most convenient."

1. **Stage 0, probe** (`tools/webauthn-probe/`, a separate dev-only extension; Mac runs 1–3 done, §0A; blob tests,
   restart and Windows pending). It measures:
   - the extension-origin RP ID with each provider;
   - PRF at `create()` and at `get()`;
   - the BE/BS flags;
   - whether the toolbar popup survives the OS dialog.
2. **Stage 1, session PIN and quick lock** (about 1.5 weeks; **built and merged**, notes in
   `docs/design/notes/QUICK-PIN-NOTES.md`). It covers:
   - `sk_quick`, `sk_pin`, soft and hard locks, the 5-try counter and the 12-hour cap (§5.2–§5.5);
   - the PIN field in the popup;
   - the quick lock: Lock now, a keyboard shortcut handled by the service worker, and an optional lock when the popup
     closes (§5.12).
3. **Stage 2, device unlock** (about 2–2.5 weeks). It covers:
   - `sk_prf` (reserved by `YUBIKEY-DESIGN.md` §1.2.1, extended to platform authenticators);
   - enrolment in Settings › Security, which classifies each credential as `prf` (persistent) or `gate` (session only,
     on top of Stage 1's layer);
   - the synced opt-in, the 14-day reminder, unlock in the popup;
   - virtual-authenticator tests.
4. Stage 3: first run (§0A.5 item 4), hints, docs. Stage 4: security keys (YubiKey C) on the same records.

### 0.5 Owner decisions (2026-10-19)

These are decided and are not reopened here. §9 keeps the questions as they were asked, with the answers.

| # | Decision | Where it is recorded |
|---|---|---|
| **Q1** | **Yes: reopen F25, only for the memory-only session unlock.** That is the Sixkey PIN fallback and Touch ID / Windows Hello without PRF. **Confirmed by the owner (2026-10-19): Q1 covers both, as one memory-only class.** Nothing on disk opens the vault, and it ends at browser restart. The gate carries the honest convenience-level label (`quickOnGate`: the key sits in memory as is, so programs on the computer and developer tools are not stopped). It ends at browser restart, 12 h after the master password, after 5 wrong PINs, and with any key change. It is never offered in the shared/scripted mode. A PIN or gate stored in the profile stays rejected. | SYNC-DESIGN §13 F25 row and §12 Q4 row (dated notes); `fingerprint-browser-security-lessons.md` F25 row |
| **Q2** | **Amend D25: Windows Hello (device-bound platform authenticator) yes.** **Synced passkeys** (iCloud Keychain, Google Password Manager, third-party providers) may unlock across restarts **only as an opt-in, off by default**. The user turns it on at enrolment, after a plain-language notice that this puts a passkey in Apple's or Google's (or the provider's) cloud (§5.3 step 3, copy `quickSyncedOptIn` and `quickSyncedNotice`). Without the opt-in, a synced passkey is used only as the session gate. D25's three checks stay as they are for security keys. | `YUBIKEY-DESIGN.md` §0.00 Q2 row, D25 row, §1.2.2 step 3, §7.4 Q2 row (dated notes) |
| **Q3** | **Yes: ask for the master password every 14 days** for the persistent device unlock, enforced in the service (as `YUBIKEY-DESIGN.md` D17). | here, §5.4 |

What this means on a Mac: by default, Touch ID unlocks Sixkey only until the browser closes. Touch ID **with PRF**
exists in Chrome only through iCloud Keychain or Google Password Manager, and both sync, so surviving a restart needs
the opt-in. Mac runs 1 and 2 (§0A) confirmed this for both providers: Google Password Manager (the save location Chrome
154 used by default) and iCloud Keychain. PRF works in each, from the toolbar popup, and each passkey is synced
(BE = BS = 1). Whether a device-bound credential with PRF exists on macOS is still unmeasured.

One conditional question remains, and is asked only if Stage 0 fails: if Windows Hello or iCloud Keychain refuse the
extension-origin RP ID, fall back to RP ID `sixkey.app`? That needs the host permission and is shared with the website
and broad extensions (§1.6). The alternative is to ship only the session gate on that platform.

## 0A. Stage 0 results

### 0A.1 Mac, run 1: Google Password Manager (2026-10-19)

The owner ran `tools/webauthn-probe` 0.1.0, unpacked, extension ID `njdbikfohkkhggiioodjgoocenlmhaed`. Everything in
this section is **[verified] for this one configuration only**:

- Chrome 154.0.8037.95 on macOS 27.0.0 (`userAgentData` platformVersion; the frozen user-agent string says 10_15_7),
  arm64, UI language zh-CN;
- the passkey saved to **Google Password Manager**, synced with the owner's Chrome (Google) account. The owner
  confirmed this, and the AAGUID agrees (below).

| What | Result |
|---|---|
| `isUserVerifyingPlatformAuthenticatorAvailable()` | `true` |
| `isConditionalMediationAvailable()` | `true` |
| `getClientCapabilities()` | `extension:prf` **true**, `hmacCreateSecret` true, `passkeyPlatformAuthenticator` true, `immediateGet` true, `relatedOrigins` true, `hybridTransport` true |
| `create()` request | RP = the extension's own origin (no `rp.id`); `authenticatorAttachment: "platform"`; `userVerification: "required"`; `residentKey: "preferred"`; `hints: ["client-device"]`; PRF `eval` with salt A |
| `create()`, attempt 1 (popup) | `NotAllowedError` after 2.5 s, focus lost during the ceremony. Probably dismissed by the user [unverified] |
| `create()`, attempt 2 | ok, 5.7 s |
| Provider | AAGUID `ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4`. That is "Google Password Manager" in the community AAGUID list (passkeydeveloper/passkey-authenticator-aaguids `aaguid.json` [transcribed]) and matches the owner's statement. For comparison, from the same list [transcribed]: `fbfc3007-154e-4ecc-8c0b-6e020557d7bd` "Apple Passwords" (iCloud Keychain); `dd4ec289-e01d-41c9-bb89-70fa845d4bf2` "iCloud Keychain (Managed)"; `adce0002-35bc-c60a-648b-0b25f1f05503` "Chrome on Mac" (the Chrome-profile authenticator); `08987058-cadc-4b81-b6e1-30de50dcbe96`, `9ddd1817-af5a-4672-a2b9-3e3dd95000a9`, `6028b017-b1d4-4c02-b4b3-afcdafc96bb2` "Windows Hello" |
| Flags | UP, UV, AT; **BE = 1, BS = 1: a synced passkey** |
| Transports | `["hybrid", "internal"]` |
| `credProps.rk` | `true` |
| PRF at `create()` | `enabled: true` **and** `results.first` present (32 bytes) |
| RP ID hash | SHA-256 of `chrome-extension://<id>`: Google Password Manager accepted the non-domain RP string |
| `get()` ×3 in each of popup, small window, tab | all ok, UV set, signatures verified with WebCrypto |
| PRF consistency | same salt → same value, also equal to the `create()`-time value; different salt → different value. `prf.enabled` is null at `get()`, as expected (it is a creation-time output) |
| User activation | Call 1 in each context followed the button click. Calls 2 and 3 ran with `navigator.userActivation.isActive` **false** and still succeeded, so Chrome did not need fresh transient activation for `get()` here. A `get()` with no interaction at all since the page opened (the "start by itself" checkbox) was **not** run |
| Popup lifecycle | At each ceremony start the popup got a `blur`, but no `pagehide` and no `hidden` until the user closed it later. **The toolbar popup survived the dialog** for `create()` and every `get()` |

**What this changes in the design**

1. **Verified for Mac + Google Password Manager:**
   - the extension-origin RP ID works (§1.6);
   - PRF comes back at `create()` and at `get()`, stable per salt (§1.5);
   - `get()` needs no fresh user activation;
   - the toolbar popup survives, so the departure from D16 is justified for this configuration (§1.6). Windows, iCloud
     Keychain and a local credential are still to be measured. Until then, the small window stays the fallback
     everywhere else.
2. **The credential Chrome creates by default here is synced.** Chrome 154 saved it to Google Password Manager without
   asking. Under the owner's decision Q2 (synced passkeys opt-in, off by default), Sixkey's default enrolment on this Mac
   therefore ends as the **session gate**, not the persistent unlock. A persistent Touch ID unlock on this Mac is today
   an opt-in: §5.3 step 3 already handles exactly this case. Stage 0 had to find out whether a **device-bound,
   PRF-capable** path exists on macOS at all (answered by run 3, §0A.4: not with the Chrome profile). Corbado says the Chrome-profile authenticator ("Chrome on Mac") has no PRF
   [transcribed], and iCloud Keychain syncs too. If no such path exists, the Mac default stays session-only, with the
   opt-in for restarts. That is a consequence of Q2, not a new question.
3. **Sixkey cannot choose the save location.** `hints: ["client-device"]` did not keep Chrome away from Google Password
   Manager. The enrolment screen must therefore expect any provider. It classifies by the BE flag after the fact
   (§5.3), and tells the user why a credential became a gate and how to opt in (`prfSyncedRefused`). Variations of
   attachment and hints are in the next runs (probe 0.1.1 adds both choices).
4. **`getClientCapabilities()` `extension:prf` was a true positive here.** It stays a hint; the verification `get()`
   decides (§1.5).
5. **Release-order constraint: a stable extension ID.** The RP ID is `chrome-extension://<id>`, so every passkey is bound
   to the extension ID. Unpacked and dev IDs differ from the store ID, and a passkey made under one never works under
   another. Three consequences:
   - dev builds need a fixed `key` in `manifest.dev.json`, so a developer's enrolments survive reinstalls and moved
     folders (`e2e` builds do not: the virtual authenticator does not care);
   - the store ID must be final **before** this feature ships to users, the same order YubiKey A already has for its
     `allowed_origins`;
   - an ID change later would strand every enrolment. Nobody would lose data (they fall back to the master password),
     but it must never happen casually.
6. **Clean-up:** the test passkey `sixkey-probe-delete-me` is in the owner's Google account. Delete it in
   `chrome://password-manager/passwords` (or passwords.google.com); it then disappears from the other synced devices
   too.

### 0A.2 Mac, run 2: iCloud Keychain (2026-10-19)

Probe 0.1.1, the toolbar popup only, with the same Chrome 154.0.8037.95 on macOS 27.0.0. **[verified] for this
configuration only.**

| What | Result |
|---|---|
| Provider | AAGUID `fbfc3007-154e-4ecc-8c0b-6e020557d7bd`: "Apple Passwords" (iCloud Keychain) in the community list [transcribed] |
| Credential | ID length 20; flags UP, UV, AT; **BE = 1, BS = 1: synced** (iCloud); transports `["hybrid", "internal"]`; `credProps.rk` true |
| PRF at `create()` | `enabled: true` and `results.first` present (32 bytes) |
| RP ID | the extension-origin RP string was accepted (the `create()` and every `get()` succeeded with no `rp.id`) |
| `get()` ×3 in the popup | all ok: A1 2.4 s, A2 3.4 s, B1 2.4 s; signatures verified |
| PRF consistency | same salt → same value, equal to the `create()`-time value; different salt → different value |
| User activation | A2 and B1 again succeeded with `userActivation.isActive` false |
| Popup lifecycle | only `blur` / `focus` during the ceremonies; no `pagehide` or `hidden` until the owner closed it. **The popup survived** `create()` and all three `get()`s |
| Not run this time | small window, tab, restart, no-click auto-start |

### 0A.3 Interim conclusions after runs 1–2 (kept as written; §0A.5 supersedes them where it differs)

1. **Two synced PRF paths work from an extension page, both in the toolbar popup:** Google Password Manager and iCloud
   Keychain.
   - The extension-origin RP ID is accepted by both.
   - PRF is returned at `create()` and at `get()`, stable per salt.
   - No fresh user activation is needed for `get()`.
   - Running in the popup (the departure from D16) holds for both on this Mac.
2. **Both are synced (BE = BS = 1).** Under Q2 they give the persistent unlock only after the user opts in. Without the
   opt-in they give the session gate.
3. **The open question is a non-synced, device-bound Touch ID credential with PRF on macOS** (the Chrome-profile
   authenticator, AAGUID `adce0002-35bc-c60a-648b-0b25f1f05503` "Chrome on Mac"). Corbado says it has no PRF
   [transcribed]. If that holds, Mac users choose between the session gate (default) and the opt-in synced persistent
   unlock, as Q2 already implies.
4. iCloud Keychain also proves that the RP string is accepted by Apple's provider, not only by Google's. That removes
   the iCloud half of conditional question Q4. The Windows Hello half stays open.

**Clean-up:** the run-2 test passkey is in the owner's iCloud Keychain (the Passwords app › Passkeys), in addition to run
1's in Google Password Manager. Delete both.

### 0A.4 Mac, run 3: Chrome profile, device-bound (2026-10-19)

Probe 0.1.1, the same Chrome 154.0.8037.95 on macOS 27.0.0. The owner had turned off saving passkeys to Google Password
Manager. **[verified] for this configuration only.**

| What | Result |
|---|---|
| Save-location choice | Chrome's first chooser listed **"iCloud Keychain"** and **"Your Chrome profile"**. Cancelling Apple's "Save a passkey? … Passwords" sheet led to Chrome's own bubble, "Create a passkey for chrome-extension … This passkey will only be saved on this device", with Save another way / Cancel / Continue |
| `create()` in the **toolbar popup**, twice | after Continue, the popup **vanished mid-ceremony** both times. `closedDuringCeremony: "create"` at 34.4 s and at 83.9 s; no result, so `create()` never completed in the popup |
| `create()` in the **small window** | ok, 10 s |
| Provider | AAGUID `adce0002-35bc-c60a-648b-0b25f1f05503`: "Chrome on Mac" (the Chrome-profile authenticator) in the community list [transcribed] |
| Credential | ID length 32; flags UP, UV, AT; **BE = 0, BS = 0: not synced, device-bound**; transports `["internal"]`; `credProps.rk` true |
| PRF | **`enabled: false`; no PRF result** at `create()` or at any `get()` |
| `get()` ×3 in the small window | all ok, UV set, 1.4–2.0 s each, one Touch ID each; signatures verified; RP ID hash = the extension origin |
| `get()` ×3 in the **toolbar popup** (addendum, same credential) | all ok (A1 1.8 s, A2 1.7 s, B1 1.4 s); UV set, BE/BS 0, signatures verified, no PRF. **The popup survived** every ceremony: `ceremony-start`, `blur`, `ceremony-end`, and no `hidden` or `pagehide` until the owner left |

### 0A.5 Conclusions after runs 1–3 (macOS 27, Chrome 154)

1. **On this Mac, a real key (PRF) exists only through synced passkeys:** Google Password Manager and iCloud Keychain
   (runs 1–2). The device-bound Chrome-profile Touch ID credential has **no PRF** (run 3), as Corbado said; that is now
   [verified] for this configuration.
   - Under Q2 (synced passkeys opt-in, off by default), the **default** on a Mac is therefore the memory-only gate class
     of Q1. Touch ID reopens Sixkey after an idle or screen lock, and the master password is needed once after every
     browser restart.
   - Surviving a restart with Touch ID needs the synced opt-in.
2. **What a device-bound credential can still be used for:**
   - **The gate, and only that.** It verifies a user-verified assertion with the stored public key, then releases the
     parked key from `storage.session` (§5.4). That costs one Touch ID of about 1.4–2.0 s per unlock.
   - **It cannot derive a key from its signature.** ECDSA with a random nonce gives a new signature each time. The
     signed bytes also change: the sign counter, and the `clientDataJSON` that Chrome writes (Chromium sometimes adds an
     extra key). Even a deterministic signature over a fixed message would only be "the authenticator's output after a
     touch", without the PRF's domain separation and UV binding. Do not build on it. Probe 0.1.2's "signature
     determinism" test records it on the real device; on the virtual authenticator the signed bytes differed (counter
     5, 6), so it says nothing there.
   - **credBlob / largeBlob (secret storage on the credential): not measured yet.** Probe 0.1.2 tests both, on a plain
     credential and on one created with the blob extensions. The virtual authenticator, with `hasLargeBlob` and
     `hasCredBlob`, wrote and read back both, so the probe's code path works.

     Even where the Chrome-profile authenticator supports them, the protection depends on **where Chrome keeps the
     blob**:
     - in the profile directory, a profile copy carries it, and it is a gate again;
     - inside the macOS keychain item, outside the profile and bound to Chrome's code signature, it would resist a
       profile copy [unverified].

     The design treats any blob as **gate level** unless that is shown. Showing it needs a profile copied to another
     macOS user, which is a separate test.
3. **Where each flow runs (Mac):**
   - **Enrolment always runs in a tab or window**, the Settings page, as §5.3 already has it. The popup closed during a
     Chrome-profile `create()`, the case where Chrome's own bubble follows Apple's sheet. The user picks the save location
     in Chrome's chooser, so Sixkey cannot know in advance that the popup would survive.
   - **Unlock (`get()`) runs in the toolbar popup.** It survived with all three providers on this Mac, so the departure
     from D16 is verified for unlock on macOS.
   - Rule: **enrol in a tab, unlock in the popup.** Windows is still to be measured.
4. **First run: ask once, in plain words.** The owner's idea fits the design, and makes the Q2 opt-in an explicit choice
   rather than a checkbox. On a Mac:
   - **"Touch ID, also after restarts"**: a synced passkey (iCloud Keychain or Google Password Manager) with PRF. The
     screen says that Apple or Google keeps the passkey, synced across your devices and end-to-end encrypted by them
     [transcribed: vendors' description], and that anyone who gets into that account and also has a copy of this browser
     profile could open Sixkey (`quickSyncedNotice`).
   - **"Touch ID on this Mac only"**: the device-bound gate. Memory only; after a browser restart, the master password
     once. **Preselected**, since synced is off by default (Q2).
   - **"A Sixkey PIN"**: the session PIN.
   - **"Not now".**

   Sixkey cannot force Chrome's save location, so the step:
   - first says which entry to pick in Chrome's dialog ("iCloud Keychain" or "Google Password Manager" for the first
     choice; "Your Chrome profile" / "only on this device" for the second);
   - then classifies what came back (BE flag, PRF result).

   On a mismatch it explains, and offers to try again:
   - "this Mac only" chosen, but a synced passkey came back: used as a gate only, no persistent wrap;
   - "also after restarts" chosen, but no PRF came back: a gate only.

   Windows gets the same step, with Windows Hello as the first choice once its run shows a device-bound credential with
   PRF.
5. **Plan consequence.** On macOS the everyday biometric experience is the gate, not the PRF unlock: the PRF unlock
   reaches Mac users only through the synced opt-in. So the device-unlock stage (Stage 2 since the reordering) builds the
   gate and the PRF classification together (§8).
6. **Clean-up after run 3:** delete the Chrome-profile test passkey (Chrome › Settings › Autofill and passwords › Google
   Password Manager, or the passkey list Chrome shows there for "Your Chrome profile" [unverified where exactly]), and
   switch Google Password Manager passkey saving back on if wanted.

**Still unmeasured:**

- credBlob / largeBlob and signature determinism on the real authenticators (probe 0.1.2);
- the browser-restart test;
- the no-interaction auto-start;
- the attachment and hints variations;
- all of Windows (Windows Hello, its PRF, BE flag, popup survival for create and get).

---

## 1. Facts that decide the design

### 1.1 What an extension can call

- **Chrome's password manager re-authentication is browser-internal C++, not an extension API.**
  - macOS: `chrome/browser/device_reauth/mac/authenticator_mac.mm` checks `LAContext canEvaluatePolicy:` with
    `LAPolicyDeviceOwnerAuthenticationWithBiometricsOrCompanion` (macOS 15+), `…WithBiometricsOrWatch` (older) or
    `LAPolicyDeviceOwnerAuthentication`. It then prompts through `password_manager_util_mac::AuthenticateUser`
    [verified, source main].
  - Windows: `chrome/browser/device_reauth/win/authenticator_win.cc` uses `Windows.Security.Credentials.UI.UserConsentVerifier`
    (`RequestVerificationForWindowAsync` on Windows 11, `RequestVerificationAsync` before that). When Windows Hello is
    unavailable it falls back to `password_manager_util_win::AuthenticateUser` [verified, source main].
  - No `chrome.*` API exposes either [inferred, high confidence: no such API exists in the extension API reference as I
    know it; not exhaustively re-checked].
- **This prompt is itself only a gate.** Chrome's saved passwords are encrypted with a key the operating system holds for
  the user's account (DPAPI and app-bound encryption on Windows, the "Chrome Safe Storage" Keychain item on macOS)
  [transcribed/unverified]. The prompt protects against a person at the unlocked computer. The OS-held key is what
  protects against a copied profile. An extension gets **neither** half: extension storage has no OS-held key (§1.4).
  Copying Chrome's UX without that key would be a gate with the key lying beside the data.
- **What an extension page can call:** WebAuthn (`navigator.credentials.create/get`) against a **platform
  authenticator** (Windows Hello, Touch ID through the Chrome profile, iCloud Keychain or Google Password Manager),
  with `userVerification: "required"`. The OS shows its own dialog, including its own fallback: Windows Hello PIN, or
  the Mac login password. That covers the owner's "fingerprint or OS password". With the **PRF** extension, the
  authenticator also returns a 32-byte secret bound to the credential and to user verification (§1.2).
- **How other password managers do it:** Bitwarden's and 1Password's extension biometric unlock goes through their
  desktop app over `nativeMessaging` ("This permission is required for the browser extension to unlock with
  biometrics", Bitwarden help [transcribed]). Bitwarden also unlocks its Chromium extension with a PRF passkey ("Your
  browser … and authenticator … must both be PRF-capable"; "Chrome profiles are not"; on Linux "pop out the extension
  first" [transcribed]). Native messaging is option G (§4.7). It is not recommended now.

### 1.2 Gate or key: what a WebAuthn assertion really gives

| | Plain assertion (UV required) | Assertion with PRF (`hmac-secret` underneath) |
|---|---|---|
| What comes back | a signature over our challenge; flags say "user present" and "user verified" | the same, plus `results.first`: 32 bytes, a function of the credential's secret, our salt and UV |
| Can it unwrap a stored key? | **No.** The signature is randomised (ECDSA) and covers a fresh challenge, so it is not a stable secret | **Yes.** KEK = HKDF(PRF output) unwraps a VK wrap stored in the profile; a wrong or absent PRF output fails AES-GCM |
| A copy of the profile | holds whatever the gate guards. If the VK is stored for the gate, the copy opens without anyone's finger | holds only the credential ID, the salt and the wrap. Useless without the authenticator and its user verification |
| Rate limiting | the OS's own, only on the path through the dialog | the OS or the hardware's, **on every path**: the secret never leaves the authenticator |

So a gate may only ever guard a key that is **not on disk**. That is the session layer (§5.4), where the key is already
in memory. Never a stored one.

### 1.3 What survives what (`chrome.storage.session` and friends)

`storage.session` is memory only: "cleared if the extension is disabled, reloaded, updated, and when the browser
restarts" (ux-study C5 [transcribed, marked 复核 there]). It is shared by Sixkey's popup, settings page and service
worker (`platform/session.ts` [verified]).

| Event | `sk_session` (unlocked VK) | proposed `sk_quick` (session quick unlock) | key in a page's memory |
|---|---|---|---|
| Popup closes | stays | stays | gone |
| Service worker stopped and restarted | stays | stays | n/a (holds none) |
| Idle timeout (alarm or timestamp check) | **removed** (today: `enforceAutoLock`) | stays (soft lock) | voided by the lock epoch |
| Screen locks, `lockOnScreenLock` on | **removed** (today: `sw.ts` `idle.onStateChanged`) | stays (soft lock) | voided |
| Computer sleeps or hibernates | stays (in browser memory; the OS may write that memory to a hibernation or swap file [inferred]) | stays | stays |
| Last window closed on macOS / Edge startup boost / ChromeOS | stays (browser keeps running; ux-study §2.6 [transcribed]) | stays: hence the **12-hour cap** | — |
| Browser quits or restarts, or crashes | gone | gone | gone |
| Extension update, reload, disable | gone | gone | gone |
| Lock mode switched (to "every time", say) | removed (`updateSettings`) | **removed** | voided |

Today's "after N idle minutes" (1–1440) and "when the browser restarts" modes already **are** the owner's candidate (a),
"remember the unlock for a time window" (`types.ts` `AutoLock` [verified]). What people actually feel is the re-entry
after an idle lock or a screen lock. The session layer is aimed at exactly that moment.

### 1.4 What a copy of the profile contains

- `chrome.storage.local` (Local Extension Settings) and IndexedDB are LevelDB files in the profile directory. Chrome
  does not encrypt them with an OS key on Windows, macOS or Linux; its OS encryption covers cookies and saved passwords
  [unverified, consistent with SYNC-DESIGN §2.1 and the repository's own `sixkey-identity` design].
- A **non-extractable** WebCrypto key stored in IndexedDB is serialised with its key material. "Non-extractable" is
  enforced by the API, not by the storage, so a copy of the IndexedDB files carries the key. SYNC-DESIGN §2.1 says the
  same ("non-extractable 也只是防 JS 导出"). The byte format was not re-checked in Chromium for this document
  [unverified].
- Some fingerprint browsers do not carry IndexedDB (BitBrowser and AdsPower by default; GoLogin wipes it,
  `local-vault.md` "Limits" [transcribed]). SYNC-DESIGN §12 Q6 decided to design for the worst case, a copy of
  everything. So "only in IndexedDB" protects nothing reliably.
- `storage.session` is not in the profile files. It can still reach the disk through the OS swap or hibernation file
  [inferred]; the unlocked key already can today (`local-vault.md` "JavaScript cannot reliably zero memory").
- No extension API offers a key bound to the TPM or the Secure Enclave, apart from WebAuthn.
  `chrome.enterprise.platformKeys` is ChromeOS-only and needs a force-installed extension [inferred].

### 1.5 Platform support for PRF with platform authenticators

| Platform | Authenticator (who keeps the credential) | PRF in Chrome | Synced (BE) | Source |
|---|---|---|---|---|
| Windows 11 24H2/25H2 **with the 2026-02 update (KB5077181, builds 26100.7840 / 26200.7840)** | Windows Hello (TPM) | `get()`: yes on those builds. `create()` reporting: "Chrome 147 committed support for PRF on create", but forum testers on 26200.8037 saw Chrome not report it on create | not synced [unverified] | Corbado, status 2026-08; Bitwarden community thread [transcribed]. Conflicts with Yubico's mid-2025 "Windows Hello does not support hmac-secret" (`YUBIKEY-DESIGN.md` §1.2.8): the later sources win **only after the Stage 0 probe** |
| Windows 11 before that update; Windows 10 | Windows Hello | no ("Builds before this update do not have PRF support"; Windows 10: "underlying OS support missing") | — | Corbado [transcribed] |
| macOS 15+ | iCloud Keychain (Touch ID or the Mac password) | yes, Chrome 132+. **[verified] on macOS 27 + Chrome 154**: PRF at `create()` and `get()`, from the toolbar popup (§0A.2) | **yes** (Apple account); **[verified]** BE = BS = 1 | Corbado; ux-study U2 [transcribed]; Stage 0 Mac run 2 |
| macOS | Chrome profile authenticator (Touch ID, this profile only) | **no** ("does not support PRF at all"); **[verified] on macOS 27 + Chrome 154**: `prf.enabled` false, no results (§0A.4) | no; **[verified]** BE = BS = 0 | Corbado; Bitwarden "Chrome profiles are not" [transcribed]; Stage 0 Mac run 3 |
| any desktop | Google Password Manager passkeys | yes ("include PRF support by default"). **[verified] on macOS 27 + Chrome 154**: PRF at `create()` and `get()`, from an extension page (§0A) | **yes** (Google account); **[verified]** BE = BS = 1 | Corbado [transcribed]; Stage 0 Mac run 1 |
| Windows / macOS | third-party passkey providers (1Password, Bitwarden …) | varies | **yes** | [unverified] |
| Linux | none built in. Google Password Manager passkeys, if signed in and syncing | through GPM only | yes | [unverified] |
| ChromeOS | platform authenticator; GPM | [unverified] | — | — |

Two consequences:

- **On a Mac, Touch ID with a real key means a synced passkey.** Without iCloud Keychain or GPM, Mac Touch ID is a gate
  only. Hence decision Q2: synced passkeys are an opt-in, off by default.
- **Windows Hello with a key needs a 2026 Windows build.** Older Windows gets the session gate.

The decisive check is always the same, and is already the rule for security keys (`YUBIKEY-DESIGN.md` YR-28): right
after `create()`, run a `get()` with a PRF salt. Only a `results.first` counts. `prf.enabled` and
`getClientCapabilities()` are hints [unverified].

### 1.6 RP ID, popup or window, user gesture

- **RP ID.** An extension page that sets no `rp.id` gets the origin string `chrome-extension://<id>` as its RP ID
  (`chrome_web_authentication_delegate.cc` `MaybeGetRelyingPartyIdOverride`, `YUBIKEY-DESIGN.md` §1.2.6 [verified there,
  source main]). No other extension or website can assert for it ("Extensions will not be allowed to claim an RP ID
  that is unique to another extension", Chrome team 2023-12 [transcribed]).
  - Chrome's own side is now confirmed with the virtual authenticator (`tools/webauthn-probe`, Playwright 1.64.1's
    bundled Chromium, 2026-10-19) [verified there]:
    - the authenticator received SHA-256 of `chrome-extension://<id>` as the RP ID hash;
    - `create()` and `get()` with PRF worked from an extension page, with a stable value per salt;
    - BE and BS were passed through;
    - ES256 assertions verified with WebCrypto.

    The OS authenticators are what Stage 0 must still show.
  - The ID differs for unpacked copies, so enrolments do not carry between a dev copy and the store copy. They fall back
    to the password, and no data is lost.
  - **Google Password Manager and iCloud Keychain on macOS accept the non-domain RP string** [verified, Stage 0 Mac runs
    1 and 2, §0A]. **Still unknown:** whether Windows Hello (`webauthn.dll`) accepts it [unverified].
  - The fallback, RP ID `sixkey.app` through the optional host permission (Chrome 122+, ux-study C23 [transcribed]),
    has three costs:
    - the host permission must stay granted for every unlock, not only while sync is on;
    - the website, any subdomain (an XSS) and any extension with `<all_urls>` could assert for it;
    - a synced `sixkey.app` passkey would be offered on the website too.

    Hence it is a conditional owner question, not a default.
- **Popup or window.** The evidence is uneven:
  - Chrome 156 force-closes the toolbar popup when a security dialog appears, but skips dialogs the popup itself opened
    ("Don't close if a web modal dialog (e.g. webauthn security key dialog) is showing", YR-29 [transcribed]).
  - A Firefox bug reporter says Chromium supports "a WebAuthn ceremony triggered from a web extension popup without
    closing" (bugzilla 2026687 [transcribed]).
  - Bitwarden asks for a pop-out on **Linux only** [transcribed].
  - Windows Hello is a system dialog, and losing focus may close the popup [inferred].
  - **Measured: on macOS 27 + Chrome 154, with Google Password Manager and with iCloud Keychain, the popup survived**
    `create()` and three `get()`s. It saw `blur` / `focus` but no `pagehide` or `hidden` (§0A) [verified for those two
    configurations only]. With the **Chrome-profile** credential, `get()` in the popup also survived, but `create()` did
    not: the popup vanished twice mid-ceremony (§0A.4). Hence: enrol in a tab, unlock in the popup.

  For security keys, `YUBIKEY-DESIGN.md` D16 always uses a small window, because of PIN entry and waits of up to 60 s.
  A platform biometric takes one or two seconds and has no key PIN, so this proposal **departs from D16 for platform
  authenticators only**. The ceremony runs in the popup on each OS where Stage 0 shows the popup survives. Elsewhere it
  runs in the small window (`chrome.windows.create`, `popup/index.html?mode=window`). A popup closed mid-ceremony has
  written nothing, so nothing is lost.
- **User gesture.** Chrome requires a **focused** document for WebAuthn.
  - It did **not** require fresh transient activation for `get()`: calls 2 and 3 of each run had
    `userActivation.isActive` false and succeeded [verified on Mac run 1, §0A].
  - Whether a `get()` started with **no interaction at all** since the popup opened also works is still to measure, with
    the probe's "start by itself" checkbox [unverified].

  If it does, the popup can start Touch ID as it opens: one click on the icon, one touch. A window is never opened unasked: there the lock screen shows a focused button, and Enter
  starts it.

### 1.7 What a PIN costs an attacker who has a copy

The repository's figure is one RTX 4090 at about **15,000 guesses/s** against PBKDF2-SHA256 at 600,000 iterations
(PLAN §5.1 [transcribed]), about 9×10⁹ iterations per second. Times to try **every** PIN on **one** GPU:

| PIN | Possibilities | PBKDF2 600k (today's floor) | PBKDF2 20M (the code's maximum, `kdf.ts`) |
|---|---|---|---|
| 4 digits | 10⁴ | 0.7 s | 22 s |
| 6 digits | 10⁶ | 67 s | 37 min |
| 8 digits | 10⁸ | 1.9 h | 2.6 days |
| master password, 50-bit floor | 1.1×10¹⁵ | ~2,400 years | — |

- **Working backwards.** A 600k unlock takes about 40 ms on an M3 Max and 0.4–1 s on a low-end machine (PLAN §5.1).
  The iteration count has to suit the slowest supported machine. Even allowing a **10-second** unlock:
  - on the low-end machine that is about 6M iterations, or 1,500 guesses/s on the GPU: 6 digits in about **11 minutes**;
  - on the M3 Max it would be about 150M iterations: 6 digits in about 4.6 h.

  Both fall linearly with more GPUs. A rented GPU costs well under a dollar an hour [estimate, unverified].
- **Argon2id** is not in WebCrypto. PLAN §5.1 decided "no wasm Argon2; wait for native support", and a wasm build would
  also need `'wasm-unsafe-eval'` in the exact CSP that `check-dist` enforces. Even with Argon2id at 256 MiB (t = 3), a
  24 GB card should still manage on the order of a hundred to a few hundred guesses per second [estimate, unverified]:
  6 digits in about an hour, 8 digits in a few GPU-days.
- **The gap:** 50 bits against about 20 is a factor of about 10⁹. A client-side KDF buys a constant factor of 10–100.
  It cannot buy 10⁹. An attempt limit cannot help either, because a copy has no attempt limit (F23).
- **Since 2026-10-22 (OWNER-DECISIONS/15)** the 50 bits are no longer a floor: the master password is the user's own,
  and below 50 estimated bits the settings page warns and accepts "Use anyway" (under 10⁶ estimated guesses, about 20
  bits, it refuses). New master-password wraps use
  2,000,000 iterations (157 ms in Chrome on an M3 Max; docs/design/notes/OWN-PASSWORD-NOTES.md §2). The argument above
  is unchanged: a password of 12 characters or more that the user chose is still far above a PIN, and a PIN on disk
  stays ruled out (the decision keeps "PIN 在浏览器重启后失效，最多 12 小时").

---

## 2. Threat model

The attackers of `docs/security/local-vault.md` and SYNC-DESIGN §1.2, named for this feature:

| # | Attacker | Has |
|---|---|---|
| T1 | **Casual person at the unlocked computer** (a colleague, a family member), who does not open developer tools | the browser, Sixkey's UI |
| T2 | **Shoulder-surfer** | the PIN or OS PIN they watched being typed, and maybe later physical access |
| T3 | **Profile copy** (A3): vendor sync, a cloned or shared profile, a backup, a stolen powered-off disk without disk encryption | every file of the profile; unlimited offline time |
| T4 | **Same-user malware, or A10** (a process on the debugging port: automation, an AI agent) | code execution in Sixkey's pages and service worker, or as the user; `storage.session`; keystrokes |
| T5 | **Stolen unlocked laptop**, or T1 who opens developer tools ("Inspect popup", the service worker's inspector) | T1 plus the ability to read `storage.local` and `storage.session` [inferred: available unless a policy turns off developer tools] |
| T6 | **Holder of a synced-passkey account** (someone with the user's Apple or Google account and its device check) | the passkey on another device |

Not defended against, as today: T4 while Sixkey is unlocked. It can read the vault key, and the master password as it
is typed.

---

## 3. The options compared

✓ = protected. ✗ = not protected. "—" = not applicable. The "Copy" column is T3 with nothing else.

| Option | Survives restart | Copy (T3) | Malware / A10 (T4) | At the computer (T1) | Dev tools / thief (T5) | Shoulder-surf (T2) | Can it lose data? | New permission | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **A** PIN as a UI gate, key stored beside the data | yes | ✗ instantly | ✗ | ✓ (5 tries) | ✗ instantly | PIN + access = in | no, if the master password stays the root | no | **reject** (downgrades every H1 vault; F25) |
| **B** PIN wraps the VK, stored, expensive KDF | yes | ✗ seconds to hours (§1.7) | ✗ | ✓ | ✗ (offline) | PIN + access = in | no | no (or wasm CSP for Argon2) | **reject** |
| **C** PIN + non-extractable key in IndexedDB | yes | ✗ same as B (the key is in the copy) | ✗ | ✓ | ✗ | PIN + access = in | no; GoLogin wipes it, falls back to password | no | **reject** (§13, §2.1) |
| **D-prf device-bound** Windows Hello with PRF | **yes** | ✓ | prompt the user must approve | ✓ (OS sign-in) | ✓ (needs face, finger or Windows PIN) | Windows PIN + this PC = in | no | no | **recommend** (core) |
| **D-prf synced** iCloud Keychain / GPM / password manager | **yes** | ✓ | prompt the user must approve | ✓ | ✓ | OS password + this Mac = in | no | no | **opt-in, off by default** (Q2, 2026-10-19); labelled (T6 can open it with a copy) |
| **D-gate** Touch ID / Hello without PRF, key in memory only | no | ✓ (nothing on disk) | ✗ (key readable) | ✓ | ✗ | OS PIN + access = in | no | no | **recommend** (session layer) |
| **D-gate stored** the same gate, key on disk | yes | ✗ instantly | ✗ | ✓ | ✗ | — | no | no | **reject** (= A) |
| **E** longer time window (exists today) | per mode | ✓ | ✗ for the window | ✗ for the window | ✗ | — | no | no | keep; no change needed |
| **F** session PIN: master password, then a PIN until restart or 12 h, 5 tries | no | ✓ (nothing on disk) | ✗ (PIN-wrapped key cracked in seconds to minutes) | ✓ (5 tries) | ✗ (same) | PIN + access, within the window | no | no | **recommend as fallback** |
| **G** native helper with an OS keychain / TPM key (Bitwarden, 1Password) | yes | ✓ | prompt | ✓ | ✓ | — | no | `nativeMessaging` + installer | not now (§13 rejects it; L effort) |
| **H** PIN checked by the server (Proton Pass) | yes | ✓ while the server limits tries | — | ✓ | ✓ | — | needs the network | host permission | **reject** (S3: codes never depend on a server; offline use) |

---

## 4. Per-option analysis

### 4.1 A: PIN as a gate only

The VK must open without any secret, so a wrap of it is stored next to the data: the Phase 0 device key, renamed. Every
H1 vault would lose its protection against copies the moment a PIN is set. The 5-try limit binds only people who use
Sixkey's UI: developer tools read the stored key directly. A "wipe after N tries" variant would break "never lose data"
and give colleagues a denial-of-service button (F23). If the owner wants it anyway, the only honest label is "PIN (no
protection if this browser profile is copied)", the same as "No master password yet". **Rejected.**

### 4.2 B: PIN wrapping the VK with an expensive KDF

§1.7: 6 digits fall in 67 seconds at today's floor, and in 11 minutes at the most a slow laptop can afford. Argon2 would
need wasm (decided against), a CSP change, more memory in the popup, and a lazily loaded chunk. It still falls in hours
to days. The PIN also cannot be held to "5 wrong tries": a copy tries forever. **Rejected.** It is still the right
analysis to show the owner, because it is the honest price of "a PIN that works after a restart, without hardware".

> **Dated note (2026-10-27).** The owner chose it as an opt-in, off by default (OWNER-DECISIONS/20 item 2). As built:
> PBKDF2-SHA256 at the master password's count on top of the PIN's own 600,000 (no Argon2: no wasm, the CSP), a PIN of 6
> digits or more, the 14 days of §0.5 Q3, 5 tries counted on the record before each derivation, a key change pausing it;
> `docs/design/notes/PIN-RESTART-NOTES.md`. **Superseded twice on 2026-10-30:** any PIN of 4 to 8 digits (the 6-digit
> floor dropped), then no switch and no 14 days: every PIN set has the record, the only limit 5 wrong tries in a row
> (PIN-RESTART-NOTES.md §17, §18).

### 4.3 C: PIN plus a "device-bound" key in IndexedDB

Nothing in the profile is device-bound (§1.4). The copy carries the non-extractable key, and the attack reduces to B.
The only difference is in the fingerprint browsers that drop IndexedDB, and Q6 says not to rely on that. Same-user
malware reads the files too. **Rejected**, as SYNC-DESIGN §13 already rejected the per-device wrap.

### 4.4 D: platform authenticator (Touch ID, Windows Hello)

This is the only browser-safe way to get what makes the Windows PIN safe: a TPM, Secure Enclave or provider that
rate-limits guesses. With PRF it is a real key. Without PRF it is a gate, and only safe for a key already in memory.

- **Copy.** With PRF, the copy holds the credential ID, the salt and a wrap the authenticator alone can open.
- **Malware / A10.** It can call `get()` in a Sixkey page, or `webauthn.dll` directly on Windows with the RP string,
  credential ID and salt taken from the profile [transcribed for security keys, `YUBIKEY-DESIGN.md` §1.2.6; unverified
  for Windows Hello]. Either way the OS prompts, and the user must approve. A prompt you did not expect is one to cancel.
  While Sixkey is unlocked, A10 already has the key regardless.
- **At the computer, and a stolen unlocked laptop.** The attacker must pass Windows Hello or Touch ID. If they know the
  Windows PIN or the Mac password, they are in. **This is the equivalence the owner asked for: whoever can sign in to
  this computer as you can open Sixkey.** The settings text says so.
- **Synced passkeys (T6).** A copy plus the user's Apple or Google account, and that account's own device check, can
  open the vault. With sync on this is worse, because "copy + master password = invisible sync device" (SYNC-DESIGN A3)
  gets a second form, "copy + passkey account". Owner decision Q2 (2026-10-19): it is allowed only as an opt-in at
  enrolment, off by default, after a plain-language notice.
- **Data.** None at risk: the keyring keeps the password and recovery wraps unchanged, and the PRF wraps live outside it
  (§5.2).
- **Effort.** It shares records, crypto and window code with `YUBIKEY-DESIGN.md` C (Y3). §8 sizes it.

### 4.5 E: time window (exists)

Already shipped: idle 1–1440 minutes, or until the browser restarts. Lengthening the window weakens T1, T4 and T5 for
the whole window. It does nothing for re-entry after a screen lock. No change is proposed, except that the session layer
is aimed at the moment E cannot help.

### 4.6 F: master password, then a PIN that expires

The PIN-wrapped key lives **only in `storage.session`**:

- **Copy.** Unaffected: nothing new on disk except `sk_pin`, which is under the VK (§5.2), so it tells a copy nothing.
- **T1.** Must guess within 5 tries: 5 in 10⁶ for 6 digits, 5 in 10⁴ for 4 digits, once trivial PINs are refused.
- **T4 and T5.** They read the wrapped key from memory and crack it offline (§1.7). For them **"PIN-locked" is the same
  as unlocked**. This is F's real cost compared with today: after an idle lock today, they get nothing. With F, they
  get the vault for up to 12 hours.
- **T4 with sync on.** The same holds, and they also get what an unlocked sync device gets. That is why F (and the gate)
  are **unavailable** in the shared/scripted mode, not merely discouraged. That mode already never puts the key in
  `storage.session` (`RoutedSession`, `session.ts:41–53` [verified]).

The same exposure already exists while unlocked. A T4 attacker could also simply wait for the next unlock, or record
the master password as it is typed. So the increment is "no need to wait". The label says it plainly. Bitwarden's
"lock with master password on browser restart" keeps its PIN-wrapped key in memory the same way, and its "5 failed
attempts" rule matches (ux-study U5 [transcribed]).

### 4.7 G: native helper (how Chrome's password manager really does it)

A small native program could hold a key in the macOS Keychain with a biometric access control, or behind Windows Hello
`KeyCredentialManager`, and release it after the OS prompt. That would be the real equivalent of Chrome's own
re-authentication, and it would work without PRF on Windows 10 and older Macs. It needs `nativeMessaging`, a signed
installer for each OS, and update handling. SYNC-DESIGN §13 rejected "system keychain or native messaging for the device
key". The YubiKey helper (`YUBIKEY-DESIGN.md` A) shows the cost: about 8–10 weeks. **Not now.** If that helper ships, a
keychain-backed unlock could be added to it later, as a separate proposal.

### 4.8 H: server-checked PIN

It would make unlocking depend on the network and the server, against S3 and offline use. It also cannot work before
sync exists. **Rejected**, as in ux-study §2.6.

---

## 5. The recommended design

### 5.1 The ladder and its invariants

1. **Root:** the master password and the recovery key, in the keyring, exactly as today. The keyring gets **no new
   method**:
   - `keybundle.ts:56` requires the wraps to be exactly password + recovery;
   - the local keyring must stay byte-identical to the bundle (A4R-11);
   - `YUBIKEY-DESIGN.md` YR-24 deletes the unused `webauthn-prf` value from `METHODS`.
2. **Device unlock with a key:** a PRF wrap of the current VK in `sk_prf`, one per credential.
3. **Session quick unlock:** `sk_quick` in `storage.session`. Unlocked by the PIN **or** by a Touch ID / Windows Hello
   gate (a credential enrolled without PRF). At most one session method at a time. Since 2026-10-19 the PIN is a
   feature in its own right and the first one built (owner priority). It is available whether or not a device
   credential exists. Once a gate credential exists, the user picks which of the two the session layer uses.
4. Nothing else opens a locked page. A PIN or a gate is never written to disk in a form that opens the vault.
5. **Never offered** on a Phase 0 device-key vault (its vault opens without anything), and not before the first-run steps
   have written the vault. **Session methods are never offered in a profile declared shared or script-controlled**
   (§5.12: the `profile` marker). Revised 2026-10-19: this used to read "in 'lock every time' mode". Locking whenever the
   popup closes is now also an option for a solo profile, where the PIN reopens Sixkey.
6. **Sensitive operations still need the master password:**
   - H3 exports, a new recovery key, changing the password, rotating keys, clearing the security record;
   - every sync `pw_auth` operation;
   - enrolling or removing a quick-unlock method.

   `verifyPassword` accepts nothing else (`YUBIKEY-DESIGN.md` D17).

### 5.2 Records and cryptography

All primitives are WebCrypto: HKDF-SHA256, AES-256-GCM, PBKDF2-SHA256, ECDSA P-256 and RSASSA-PKCS1-v1_5 verify. Nothing
new to vendor.

**`sk_prf`** (`chrome.storage.local`; already reserved in `core/sync/local/keys.ts` `LOCAL_ONLY_KEYS` [verified]).
Extends `YUBIKEY-DESIGN.md` §1.2.1, so that security keys, platform authenticators and any later mechanism share one slot:

```ts
type PrfRecord = { v: 1; vaultId: string; creds: PrfCred[] /* ≤ 10 */; lastPasswordAt?: number };
type PrfCred = {
  id: string;                    // credential ID, base64url
  kind: "platform" | "security-key";
  mode: "prf" | "gate";          // decided by the verification get() at enrolment (§5.3)
  name: string;                  // ≤ 40 code points, default "Touch ID" / "Windows Hello" / "Security key 1"
  synced: boolean;               // BE flag at enrolment (and BS last seen); policy: §5.3 step 3 (Q2)
  transports?: string[];
  createdAt: number;
  // mode "prf":
  salt?: string;                 // 32 random bytes per credential
  wrap?: { vkId: string; iv: string; wrapped: string } | null;   // null = "turn back on" (YUBIKEY D13)
  // mode "gate":
  publicKey?: string;            // SPKI, base64 (AuthenticatorAttestationResponse.getPublicKey())
  alg?: -7 | -257;               // ES256 or RS256 (Windows Hello commonly uses RS256 [unverified])
};
```

- PRF wrap, exactly as `YUBIKEY-DESIGN.md` §1.2.1: `KEK = HKDF-SHA256(PRF output, ∅, "sixkey/v1/kek-prf")`;
  `wrapped = AES-GCM(KEK, VK, AAD = "sixkey-prf|1|{vaultId}|{vkId}|{credId}")`. The WebAuthn PRF extension already
  domain-separates our salt from raw `hmac-secret` inputs by hashing it with the "WebAuthn PRF" context string
  [transcribed from the WebAuthn spec, not re-read].
- A gate credential holds **no key material** at all. It holds only the public key, used to check that an assertion
  really carried user verification (§5.4).

**`sk_pin`** (`chrome.storage.local`, new, to be added to `LOCAL_ONLY_KEYS`). The PIN fallback's setup, so that it
comes back by itself after the master password:

```ts
type PinRecord = {
  v: 1; vaultId: string; vkId: string;
  digits: 4 | 5 | 6 | 7 | 8;
  kdf: Pbkdf2Params;             // reuses kdf.ts: ≥ 600k iterations, enforced on read, 16-byte salt
  iv: string; wrapped: string;   // AES-GCM(HKDF(VK, ∅, "sixkey/v1/pin-cfg"), pinKek, AAD "sixkey-pin|1|{vaultId}|{vkId}")
};
```

- `pinKek = PBKDF2(NFKC(PIN), salt, iterations, 256 bits)`. The PIN itself is never stored.
- **Whoever holds the VK can recover the PIN** by brute force. They already hold every secret, but a PIN reused
  elsewhere (a phone, a bank card) would leak. The setup text tells people not to reuse one.
- NFKC (`normalizePassword`) lets full-width digits from a Chinese IME (`１２３４５６`) count as `123456`.

**`sk_quick`** (`chrome.storage.session` **only**, new). The parked key of the session layer:

```ts
type QuickSession = {
  v: 1; vaultId: string; vkId: string;
  method: "pin" | "device";
  credId?: string;               // method "device": the gate credential
  armedAt: number;               // when the master password (or a PRF unlock) last opened the vault
  expiresAt: number;             // armedAt + 12 h (§9 Q1)
  triesLeft?: number;            // method "pin": starts at 5
  digits?: number;               // method "pin": for the input's length and auto-submit
  // method "pin": AES-GCM(pinKek, VK, AAD "sixkey-quick|1|{vaultId}|{vkId}|{armedAt}|{expiresAt}")
  // method "device": the VK itself, base64, as in sk_session. Not protected: the gate is the UI. Said in the code.
  iv?: string; wrapped?: string; vk?: string;
};
```

- The AAD binds the expiry, so an edited `expiresAt` breaks the unwrap. It does not stop T4, which can read and crack
  the record anyway. It only keeps an honest bug from extending the window.
- New HKDF labels `sixkey/v1/kek-prf` (shared with YubiKey) and `sixkey/v1/pin-cfg` join the test that requires every
  label to be distinct.

**Not stored anywhere:**

- PIN digits, PRF outputs, assertions and challenges are never in a log, the diagnostics file, the security record, the
  mirror, backups, exports or sync.
- `sk_prf` and `sk_pin` are not vault data (`hasAnyData`), not mirrored, and not deleted by "turn sync off".

### 5.3 Enrolment (Settings › Security › Quick unlock, in a tab)

Requirements: unlocked, with a master password. Not a device-key vault.

1. "Use Touch ID" (macOS) / "Use Windows Hello" (Windows) / "Use this computer's sign-in" (elsewhere). Which button
   appears is decided by `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`. If it is false, only the
   PIN is offered. First the **master password is typed again** (the same call as the H3 export check): adding a way in
   is sensitive.
2. Call `navigator.credentials.create` with:
   - `rp: {name: "Sixkey"}` and **no `rp.id`**;
   - `user: {id: 16 random bytes, name: "Sixkey", displayName: "Sixkey unlock · <date>"}`: nothing personal, and the
     date tells several Macs apart in a synced provider;
   - `pubKeyCredParams: [-7, -257]`;
   - `authenticatorSelection: {authenticatorAttachment: "platform", residentKey: "required", userVerification: "required"}`
     (resident, because `webauthn.dll` may enable `hmac-secret` only for discoverable credentials, YR-28 [transcribed]);
   - `hints: ["client-device"]`, `attestation: "none"`, `excludeCredentials` set to the credentials this install already
     has;
   - `extensions: {prf: {eval: {first: salt}}}`. Pass the salt at creation, because Windows Hello does not report PRF
     support otherwise (ux-study U4 [transcribed]).
3. Read the flags from `getAuthenticatorData()`: BE (`0x08`) and BS (`0x10`). The policy is decision Q2:
   - **Before `create()`**, the step shows one checkbox, **unchecked by default**: "Allow a passkey that syncs to Apple,
     Google or your password manager" (`quickSyncedOptIn`). Ticking it first shows the notice `quickSyncedNotice`, which
     says plainly that the passkey will sit in that company's cloud and that their account becomes a second way in.
     The master password was typed in step 1 of this same flow. Nothing persistent is stored for the choice: it applies
     to this one enrolment, and the credential's `synced` flag records the outcome.
   - BE clear: as below (`prf` or `gate`).
   - BE set, box **not** ticked: the persistent PRF wrap is not made. The credential is kept as a **gate** (session only),
     and the screen says why (`prfSyncedRefused`).
   - BE set, box ticked: as below. The list marks it "Synced", and with sync on the enrolment repeats §5.9's residual.
4. **Verify once, and let that decide** (YR-28): a `get()` with `allowCredentials: [new id]`, `userVerification: "required"`
   and the PRF salt. This makes enrolment one touch for `create()` plus one for this check.
   - `results.first` present: `mode: "prf"`. Wrap the VK in the vault lock (`webLock("sixkey-vault")`), after checking
     that the active VK is still the one just used. Record `prf_enrolled`.
   - No PRF result, but a valid assertion with UV: `mode: "gate"`. Save the public key and show the session label
     (§6.4). Record `prf_enrolled` with no detail.
   - Cancelled or failed: save nothing.
5. **The list:** each method's name, "Unlocks after a restart" or "Until the browser closes", "Synced" if BE was set, the
   date added, and "Remove".

### 5.4 Unlock flows

**Lock screen.** It reads `sk_prf` and `sk_pin` with its existing reads (§5.10), and `sk_quick` from `storage.session`.
It offers, in this order:

1. A PRF credential, if one has a wrap, `lastPasswordAt` is less than 14 days old (Q3), and the vault and VK ids match:
   "Unlock with Touch ID" / "Unlock with Windows Hello".
   - In the popup, where Stage 0 says the OS dialog does not close it, it **starts by itself** as the popup opens.
   - Elsewhere, Enter on the focused button opens the small window, which starts it. The window first says one line:
     "Your computer will ask you to confirm it's you…".
2. Otherwise, a live `sk_quick`: the gate button, or the PIN field.
3. Always: the master password field one tab stop away, "Use recovery code" (earlier name), and "Forgot password" (unchanged).

**PRF unlock** (`VaultService.unlockWithPrf`):

1. Call `get()` with every usable credential and `evalByCredential`.
2. Find the record by `rawId`. On a vault or VK mismatch, or `wrap: null`, do not try to decrypt: show "turn back on"
   (YUBIKEY §1.2.5) and record no failure.
3. Otherwise derive the KEK, unwrap, and check the VK id.
4. Call the **same** `startSession(vk, epoch)` as a password unlock, with the epoch read before the ceremony began, so a
   lock during the ceremony voids the session.
5. A failed unwrap records `prf_failed`, never `unlock_failed`. A cancel (`NotAllowedError`) records nothing.
6. The 14-day rule is enforced **in the service**, not only by which button shows. It is a reminder, not a security
   control (YR-14): whoever can write `storage.local` can extend it.

**Gate unlock** (`unlockWithDeviceGate`):

1. Check that `sk_quick.method === "device"`, it has not expired, and `now ≥ armedAt − 60 s` (a clock moved back counts
   as expired).
2. Call `get({allowCredentials: [credId], challenge: 32 random bytes, userVerification: "required"})`.
3. Verify locally:
   - `clientDataJSON` has `type: "webauthn.get"`, our challenge, `origin === location.origin`, and `crossOrigin` false;
   - `rpIdHash` equals SHA-256 of the RP string;
   - the UP and UV flags are both set;
   - the signature over `authData ‖ SHA-256(clientDataJSON)` checks against the stored key (ES256 DER → raw, or RS256).
4. If it passes, `startSession` with `sk_quick.vk`.

This protects against bugs and unexpected authenticators. It does nothing against T4, which reads `sk_quick` directly,
and the label says so.

**PIN unlock** (`unlockWithPin`). The attempt limit is real only in Sixkey's own UI, but there it must hold:

1. Inside `webLock("sixkey-quick")`: read `sk_quick`. If it has expired, has no tries left, or its ids are stale, clear
   it and answer "use the master password". Otherwise **write `triesLeft − 1` first**, then release the lock. Closing
   the popup during the key derivation still spends the try, and two pages cannot race the counter.
2. Derive `PBKDF2(NFKC(pin))` and unwrap.
   - Success: in the lock, write `triesLeft = 5`, then `startSession`.
   - Failure: record `pin_failed`. If no tries are left, delete `sk_quick` and record `quick_ended`. Show "Wrong PIN.
     N tries left." or "Too many wrong PINs. Enter the master password."
3. A malformed PIN (wrong length, not digits) is a typo. It is neither counted nor recorded, like an empty password
   today.
4. **PIN policy:** 4–8 digits. Refuse all-same digits, straight runs (`1234`, `987654`) and a short list of the most
   common PINs. Recommend 6 or more.

**Arming the session layer.** After every **master-password** unlock in standard or custom (non-"always") mode, if this
install has a gate credential or an `sk_pin`, the service writes `sk_quick` next to `sk_session`:

- for the PIN, it decrypts `pinKek` with the VK it now holds;
- `armedAt` is now.

A **recovery-code** unlock arms it the same way: it proves the same root. A PRF unlock does not re-arm the session
layer. The 12 hours count from the root secret, and a PRF unlock needs no session layer anyway.

### 5.5 Lock events: soft or hard

A **soft** lock removes the unlocked key (`sk_session`) and bumps `sk_lock_epoch`. It leaves `sk_quick`, so the gate or
the PIN reopens Sixkey. A **hard** lock also deletes `sk_quick`. A PRF credential is unaffected by both: it is persistent
by design.

| Event | Today | Proposed |
|---|---|---|
| Idle timeout | lock | **soft** |
| Screen lock (`lockOnScreenLock`) | lock | **soft** (the moment quick unlock exists for) |
| Lock button in the popup (Lock now, §5.12) | lock | **soft** |
| Keyboard shortcut `lock`, handled by the service worker (§5.12) | — | **soft** |
| Popup closes, with "lock when the popup closes" on (solo profile, §5.12) | — (only in "lock every time") | **soft** |
| "End quick unlock now" (Settings › Security) | — | **hard** |
| 5th wrong PIN | — | **hard** |
| 12 h after `armedAt` (alarm `sk-quick-expiry`, plus a timestamp check on every use) | — | **hard** |
| Clock earlier than `armedAt` − 60 s | — | **hard** |
| Browser restart, crash, extension update, reload | lock | **hard** (`storage.session` is gone) |
| Lock mode changed; shared preset chosen; `profile` set to shared | lock | **hard** |
| Quick unlock turned off, PIN changed, credential removed | — | **hard** |
| Any key change (rotation, reset, start over, restore, a join, adopting a remote VK) | cleanup | **hard**; `sk_pin` follows its `VkRecord` (§5.9) |

Every lock, soft or hard, ends every open flow, as SYNC-DESIGN §6 (revision 24) requires. A quick unlock never resumes
a flow.

### 5.6 Credentials over time: several devices, removal, a move, a reinstall

- **Per install.** Records are per browser profile, so each computer and each profile enrols its own. A synced passkey
  appears on the user's other devices, but without this profile's `sk_prf` (salt and wrap) it opens nothing anywhere
  else.
- **Remove** (master password first). This deletes the record and records `prf_removed`. Sixkey cannot delete the passkey
  from the OS, so the text says where it lives:
  - "Windows Settings › Accounts › Passkeys";
  - "the Passwords app (iCloud Keychain)";
  - "Google Password Manager";
  - "Chrome › Settings › Passwords" for a Chrome-profile passkey.

  The WebAuthn Signal API (`signalAllAcceptedCredentials`) could ask the provider to drop it, best effort
  [unverified: support with an extension-origin RP].
- **The OS side is gone:** the passkey deleted in the OS, Windows reinstalled, the TPM cleared, Windows Hello reset, the
  user signed out of iCloud. `get()` fails with an error the page cannot tell apart from a cancel, by design. The line
  says "Touch ID didn't work. Use your master password." Once unlocked, the settings list offers "Not working on this
  computer? Remove".
- **The profile moved to another computer** (a vendor sync, a migration). The records travel, the TPM does not, so the
  user unlocks with the password.
  - A **synced** passkey will work there (that is T6, and Q2).
  - A key change (§5.9) is how to cut off a copy that is known to exist.
- **Lost laptop.** Remove its credentials wherever possible, and rotate keys if a copy of the profile might exist
  (`local-vault.md`: LevelDB keeps old bytes).

### 5.7 Never lose data

- No path deletes, rewrites or locks away vault data. The keyring is untouched. A forgotten PIN, a removed passkey, a
  reinstalled OS or a moved profile all fall back to the master password, and that falls back to the recovery key.
- The one new risk is **forgetting the master password because it is never typed.** Two limits address it:
  - the session layer needs the password at least once per browser session, and at most every 12 h;
  - the persistent PRF unlock asks for it every 14 days (§9 Q3).

  The lock screen keeps `lockHint` ("If you forget the master password and lose the recovery code…" (earlier name)).
- The 5-try rule clears only `sk_quick` (memory). It never touches stored data (F23).

### 5.8 Security modes

| Profile (`profile` marker, §5.12) and lock mode | PRF device unlock | Session gate / PIN |
|---|---|---|
| Solo ("Only me"): idle, browser-restart or custom lock | yes | yes |
| Solo, with "lock when the popup closes" (§5.12) | yes: asked at every opening | **yes**: the PIN or gate reopens it; the vault key lives in the popup's memory only, `sk_quick` in `storage.session` |
| Shared, cloud-synced or script-controlled (the preset: lock every time, codes hidden) | yes: asked at **every** popup opening, the key in that page's memory only (as `YUBIKEY-DESIGN.md` §1.2.3) | **no**: never offered; anything found is swept by `RoutedSession` |

Choosing the shared preset is a hard lock. The settings page explains why the PIN disappeared there.

### 5.9 Sync

- **Credentials and the PIN are per device and never synced.** They are not in the vault, the keyring, the KeyBundle,
  backups or exports. Turning sync off keeps `sk_prf` and `sk_pin` (as it already keeps `sk_prf`, `sync-local.ts:182`
  [verified]).
- **VK changes.**
  - `sk_prf` is a `VkRecord` (`service.ts:129` [verified]). It nulls stale PRF wraps and keeps the credentials, so a
    single confirmation re-wraps (YUBIKEY D13).
  - `sk_pin` is a `VkRecord` whose `reencrypt` moves `pinKek` to the new VK in the same critical section. It holds no
    VK, so carrying it is harmless. Dropping it instead (and saying so) is an acceptable simplification.
  - `sk_quick` with a stale `vkId` is ignored and cleared.
- **Password changed elsewhere** (same VK): device unlock keeps working. The 14-day reminder then asks for the **new**
  password, through the existing lock-screen line P2 if the old one is typed.
- **Revoke and protect, rotation:** PRF wraps under the old VK are nulled. A copy taken earlier, plus the authenticator,
  opens only the old VK, which is D13's reason for not using an indirect key.
- **SYNC-DESIGN §3.11:** soft-locked counts as locked. The service worker holds no VK, so it pushes only the outbox.
- **Synced passkeys with sync on** add the residual of §4.4: copy + passkey account = an invisible sync device. The
  enrolment text says it when sync is on.

### 5.10 Engine and storage changes

| Where | Change |
|---|---|
| `core/crypto/prf.ts` (new) | KEK derivation, wrap and unwrap with the AAD above; pure; known-answer tests |
| `core/crypto/pin.ts` (new) | PIN policy, `pinKek` derivation (reuses `kdf.ts` `pbkdf2Bits`, `normalizePassword`, `assertKdfParams`), `sk_pin` and `sk_quick` wrap and unwrap |
| `core/crypto/assertion.ts` (new, lazily loaded) | gate assertion check: client data, `rpIdHash`, flags, ES256/RS256 signature |
| `core/crypto/keyring.ts` | remove `webauthn-prf` from `METHODS` (YR-24) |
| `core/service/service.ts` | `enrolPrf`, `removePrf`, `unlockWithPrf`, `unlockWithDeviceGate`, `setPin`, `removePin`, `unlockWithPin`, `quickState()`, `lock({ hard })`, arming after a password unlock, the 14-day check; `vkRecords` gains `sk_prf` and `sk_pin` |
| `core/service/types.ts` | `SessionCache` gains `getQuick / setQuick / clearQuick`; `UnlockedView` / `OpenView` (locked) carry `quick: {device?, pin?: {digits, triesLeft}, prf?: {...}}`; `Settings` gains `profile: "solo" \| "shared"` (§5.12, read with a fallback in `parseSettings`) |
| `core/service/security-log.ts` | kinds `prf_enrolled`, `prf_removed`, `prf_failed` (YUBIKEY R8), `pin_set`, `pin_removed`, `pin_failed`, `quick_ended`: **one** version bump for both features; the lock notice counts `pin_failed` with the wrong passwords |
| `core/sync/local/keys.ts` | `LOCAL_ONLY_KEYS` gains `pin: "sk_pin"`; the source rules test that turning sync off and `hasAnyData` ignore it |
| `core/storage/store.ts` | no change to slots, snapshots or mirror. Optionally an "also read" list on the pointer read, so `sk_prf` and `sk_pin` come with the existing first read (no new read). Otherwise one read on the lock screen, as YUBIKEY §1.2.3 budgets |
| `platform/session.ts` | `sk_quick` in `chrome.storage.session`; `RoutedSession` sweeps it in "always" mode; `clear()` stays soft, `clearAll()` is hard |
| `platform/webauthn.ts` (new) | the only file calling `navigator.credentials`; core takes bytes, so Node tests need no browser |
| `background/sw.ts` | idle and screen lock call the soft lock; `chrome.commands.onCommand` for `lock` calls it too (§5.12); a new alarm `sk-quick-expiry` deletes an expired `sk_quick` |
| `manifest.base.json`, `scripts/check-dist.mjs` | the `lock` command with suggested key `Alt+Shift+L`; the expected manifest updated (no new permission) |
| `popup/screens/Locked.tsx` | device button (lazy chunk), PIN field, tries left, `?mode=window` ceremony |
| `options/Security.tsx` | new "Ways to unlock" box (§6.3); `UnlockBar.tsx` accepts quick unlock too |
| `scripts/check-dist.mjs` | budgets as now; any new catalog file added to its list |

### 5.11 Budgets

- **Popup (60 KB gzip; 55.3 KB measured today with `node scripts/check-dist.mjs` on the current `dist/` = static 51.4 +
  zh_CN catalog 3.9).**
  - In the popup's static graph: the PIN field, the locked view's state, the button, and the lines. PBKDF2 and AES-GCM
    are already there for the keyring. That adds about +1.0–1.8 KB [estimate].
  - The WebAuthn adapter, assertion check and PRF unwrap go in a **lazy chunk**, imported only when a credential is
    enrolled. `check-dist` counts static preloads, so it stays outside the budget.
  - Expected result: about 56.8–57.6 KB [estimate]. It must be measured at every stage.
- **Catalogs.** The full zh_CN catalog is 10.9 of 12 KB (en 9.6). The settings copy of §6.5 (about 30 strings) is about
  +0.8–1.2 KB gz in zh_CN [estimate], and **probably does not fit**. Two ways out:
  - a separate catalog for Settings › Security's quick-unlock box, loaded by that box, as the Sync section's
    `catalogs/sync-<lang>.json` is;
  - raise `FULL_CATALOG_GZ`, which is the maintainer's setting.

  The popup catalog grows by about 10 strings, roughly +0.3 KB gz [estimate].
- **Reads.** A PIN unlock reads `storage.session` and uses **no more** `storage.local` reads than a password unlock
  (≤ 8, `read-budget.test.ts` [verified]). A password unlock with nothing enrolled reads and writes nothing more than
  today. With `sk_pin` set it writes `sk_quick` (session, not local). With PRF enrolled it writes `lastPasswordAt` at
  most once a day (as YUBIKEY §1.2.3, an explicit, commented exception).

### 5.12 Quick lock (Stage 1, with the PIN)

The owner's priority is "unlock with a PIN, and lock again quickly". Locking must therefore be one action from
anywhere, and it must not depend on a page being open. Every quick lock is a **soft** lock (§5.5): it removes the
unlocked vault key, bumps the lock epoch, and keeps `sk_quick`, so the PIN reopens Sixkey.

1. **Lock now in the popup.** The existing lock button (`popup/main/Main.tsx`, `rt.service.lock()`) becomes the soft
   lock.
   - It sits in the popup's header, is reachable by Tab, and has a visible label and an accessible name.
   - After it, the popup shows the PIN field at once, with focus in it.
2. **A keyboard shortcut.** A named command in the manifest, `"lock"`, with a suggested key of `Alt+Shift+L`, next to
   the existing `_execute_action` Alt+Shift+K.
   - It needs no permission. `check-dist`'s expected manifest gains the entry; `local-vault.md`'s "Permissions"
     paragraph mentions it.
   - Chrome does not assign a suggested key that conflicts with another, and the user can change it at
     `chrome://extensions/shortcuts`. Settings › Security shows the current binding through `chrome.commands.getAll()`
     (already used, no permission).
3. **The lock runs in the service worker.**
   - `chrome.commands.onCommand` is registered at the top level of `background/sw.ts`, like the other listeners, and
     calls the service's soft lock.
   - It needs no vault key and no page, and it works while no Sixkey page is open and while the worker was asleep.
   - Open pages learn of it through `storage.session.onChanged` on `sk_lock_epoch`, as `options/Backup.tsx:71–75`
     already does. They drop the key and the codes on screen at once instead of at their next use. This fixes, for
     quick locks, the "an open page keeps what it has opened" limit of `local-vault.md`.
   - The idle alarm and the screen lock call the same function.
4. **Lock when the popup closes** (an option, off by default; Settings › Security › Automatic lock). The vault key
   stays only in the popup's memory, as in "lock every time" today, so closing the popup is the lock and nothing has to
   run at close time. `sk_quick` stays in `storage.session`, so the next opening asks for the PIN, not the master
   password.
   - Allowed only in a solo profile (item 5).
   - The 12-hour cap and the browser-restart end still apply.
   - A settings tab keeps its own copy of the key, with its 15-minute ceiling (unchanged).
5. **The `profile` marker.** Whether session methods are allowed depends on what the user declared about the profile,
   not on the lock mode. Settings gain `profile: "solo" | "shared"`:
   - the first-run question and the two Security-mode cards set it ("Only me" sets solo, the shared card sets shared);
   - a custom change of a single setting leaves it as it is;
   - for a record saved before the field existed, `parseSettings` reads "shared" if the settings match the shared
     preset exactly, else "solo";
   - "shared" refuses and sweeps `sk_quick` (a hard lock).

   Like every setting, the marker is not protected by the master password (`local-vault.md` "Limits"). It guards
   against misuse; it is not a control against someone at the browser.
6. **Tests:**
   - the command wiring in the worker (as `m5-sw-wiring.test.ts` does): a command soft-locks with no page open;
   - an open page clears its codes on the epoch change;
   - lock-on-close reopens with the PIN, and after a browser restart with the master password;
   - a shared profile refuses arming, and switching to it clears `sk_quick`;
   - mutation targets: the command calling a hard lock, or no lock; the epoch listener removed; lock-on-close allowed in a
     shared profile.

---

## 6. UX

### 6.1 First run and the upgrade path

- **First run** (H1 order unchanged: password, recovery key, profile question, first account). If the answer is "Only
  me" and `isUserVerifyingPlatformAuthenticatorAvailable()` is true, one optional card follows the question: "Unlock
  faster with Touch ID / Windows Hello" [Turn on] [Not now]. It enrols in the same tab after the vault is written.
  There is no PIN card in the first run. The shared answer gets nothing.
- **Existing users.** After the second master-password unlock in the popup, one dismissible line appears: "Tired of
  typing it? Use Touch ID ›". It opens Settings › Security. Dismissed means gone (page `localStorage`, like `sk_lang`).
- **Phase 0 device-key vaults.** The "No master password yet" card adds one sentence: "Then you can open Sixkey with
  Touch ID / Windows Hello." The ask for a master password thus comes with something in return.

### 6.2 Popup: the instant-open path

1. Alt+Shift+K (or the icon). The popup opens on the lock screen.
2. If a PRF credential exists and Stage 0 allows it here, the OS dialog starts at once. Touch, and the codes appear.
   That is two actions, the same as Windows Hello at sign-in.
3. If the window is needed, the button is focused: press Enter, a 360×600 window opens, the OS dialog appears, and that
   window becomes the list.
4. If there is a session PIN, the field is focused with `inputmode="numeric"`. It auto-submits when the stored length
   is reached (the length is shown as dots anyway).
5. If something fails or is cancelled, focus moves to the master-password field. No dialog, no dead end.

### 6.3 Settings › Security: "Ways to unlock this browser"

One box that also hosts YubiKey C later:

- master password (always; "change" stays where it is);
- recovery key;
- each device credential (name, "after restarts" or "until the browser closes", "synced", date, Remove);
- the PIN (set, change, remove);
- "End quick unlock now".

Locked, it shows only the list. Every change asks for the master password. In the shared mode, the PIN row explains why
it is off.

### 6.4 Keyboard and accessibility

- Every path works without a mouse. The device button is a real `<button>`, and Enter starts it.
- The PIN is a single `<input type="password" inputmode="numeric" autocomplete="off">` with a visible label, not six
  boxes, so screen readers read one field. Its tries-left line is linked by `aria-describedby`.
- Errors use `role="alert"`, as the lock screen does today. There is no timer pressure: the 12 h are shown as a time of
  day.
- The OS dialog is the OS's. Sixkey only says beforehand what will appear.

### 6.5 Copy (en / zh_CN)

Short, and honest about what each level protects. New keys only; existing strings stay.

| Key (suggested) | en | zh_CN |
|---|---|---|
| quickTitle | Quick unlock | 快速解锁 |
| quickLead | Open Sixkey with Touch ID, Windows Hello or a PIN instead of typing the master password. The master password still works, and exports and key changes still ask for it. | 用 Touch ID、Windows Hello 或 PIN 代替输入主密码来打开 Sixkey。主密码照常可用，导出和更改密钥时仍会要求输入。 |
| quickUseTouchId / quickUseHello / quickUseDevice | Use Touch ID / Use Windows Hello / Use this computer's sign-in | 使用 Touch ID / 使用 Windows Hello / 使用这台电脑的登录验证 |
| quickOnPrf | On. Opens Sixkey on this computer, also after the browser restarts. A copy of this browser profile still needs your master password. | 已开启。在这台电脑上可以直接打开 Sixkey，浏览器重启后也可以。拿到这个浏览器配置文件副本的人，仍然需要你的主密码。 |
| quickOnPrfSynced | On. This passkey is synced by your passkey provider (such as iCloud Keychain or Google Password Manager): that account, together with a copy of this browser profile, can also open Sixkey. | 已开启。这个通行密钥由你的通行密钥服务（例如 iCloud 钥匙串或 Google 密码管理器）同步：拿到那个账户、再加上这个浏览器配置文件的副本，也能打开 Sixkey。 |
| quickOnGate | On until the browser closes. After Sixkey locks, Touch ID opens it again; after a browser restart, type the master password once. This stops people at your computer. It does not stop programs on it, or anyone who opens the browser's developer tools. | 开启到浏览器关闭为止。Sixkey 锁定后可以用 Touch ID 重新打开；浏览器重启后，需要先输入一次主密码。它能挡住坐到你电脑前的人，挡不住电脑上的程序，也挡不住会打开浏览器开发者工具的人。 |
| pinLead | PIN, 4 to 8 digits. It works only until the browser closes, and at most 12 hours after you last typed the master password. Don't reuse your phone or bank PIN. | PIN 为 4 到 8 位数字，只在浏览器关闭前有效，并且最多到你上次输入主密码后 12 小时。不要用手机或银行卡的 PIN。 |
| pinHonest | A PIN stops people at your computer. It does not stop programs on this computer, or anyone who opens the browser's developer tools. | PIN 能挡住坐到你电脑前的人，挡不住这台电脑上的程序，也挡不住会打开浏览器开发者工具的人。 |
| pinWeak | Too easy to guess. Avoid repeated digits and runs like 1234. | 太容易被猜到。请避开重复数字和 1234 这样的连续数字。 |
| quickSharedOff | Not available in this security mode: scripts that control this browser could read a PIN. Touch ID and Windows Hello still work, and are asked for every time. | 这个安全模式下不能使用：控制这个浏览器的脚本能读到 PIN。Touch ID 和 Windows Hello 照常可用，每次打开都会询问。 |
| quickNeedsPassword | Set a master password first. Then you can open Sixkey with Touch ID or Windows Hello. | 请先设置主密码，之后就可以用 Touch ID 或 Windows Hello 打开 Sixkey。 |
| quickEndNow | End quick unlock now | 立即结束快速解锁 |
| unlockTouchId / unlockHello | Unlock with Touch ID / Unlock with Windows Hello | 用 Touch ID 解锁 / 用 Windows Hello 解锁 |
| unlockWindowNote | Your computer will ask you to confirm it's you. The request may be labelled "chrome-extension": that is Sixkey. | 电脑会请你确认身份。请求方可能显示为“chrome-extension”，那就是 Sixkey。 |
| unlockDeviceFailed | That didn't work. Use your master password. | 未能完成，请使用主密码。 |
| pinLabel | PIN | PIN |
| pinWrong | Wrong PIN. $1 tries left. | PIN 不对，还可以再试 $1 次。 |
| pinExhausted | Too many wrong PINs. Enter the master password. | PIN 输错次数过多，请输入主密码。 |
| useMasterPassword | Use master password | 使用主密码 |
| prfReminder | Sixkey asks for the master password every 14 days, so that you don't forget it. | Sixkey 每 14 天会请你输入一次主密码，免得忘记。 |
| prfPaused | Your keys were replaced, so unlocking with Windows Hello is paused. Confirm once to turn it back on. | 密钥已更换，用 Windows Hello 解锁已暂停。确认一次即可恢复。 |
| prfSyncedRefused | This passkey is synced by your passkey provider, so Sixkey uses it only until the browser closes. To use it after restarts too, remove it and add it again with "Allow a passkey that syncs" ticked. | 这个通行密钥会被你的通行密钥服务同步，所以 Sixkey 只在浏览器关闭前使用它。如果想在浏览器重启后也能用，请移除后重新添加，并勾选“允许会同步的通行密钥”。 |
| quickSyncedOptIn | Allow a passkey that syncs to Apple, Google or your password manager | 允许会同步到 Apple、Google 或密码管理器的通行密钥 |
| quickSyncedNotice | Your computer or Chrome may save this passkey in a service that syncs it, such as iCloud Keychain, Google Password Manager or your password manager. It is then kept in that company's cloud and on your other devices. Anyone who gets into that account and also has a copy of this browser profile could open Sixkey without your master password. Leave this off if you are unsure: $1 still works until the browser closes. ($1 = Touch ID / Windows Hello) | 你的电脑或 Chrome 可能会把这个通行密钥存进会同步的服务，例如 iCloud 钥匙串、Google 密码管理器或你的密码管理器。它会保存在那家公司的云端和你的其他设备上。谁要是进了那个账户、又拿到这个浏览器配置文件的副本，就能不用主密码打开 Sixkey。拿不准就别开：不开的话，$1 在浏览器关闭前照样能用。（$1 = Touch ID / Windows Hello） |
| prfRemoved | Removed from Sixkey. The passkey itself is still in $1; delete it there if you no longer need it. | 已从 Sixkey 移除。通行密钥本身仍在 $1 中，不再需要的话请在那里删除。 |
| quickNothingLost | Lost or reinstalled this computer? Your master password and recovery key still open Sixkey. Nothing is lost. | 电脑丢了或重装了？主密码和恢复密钥照样能打开 Sixkey，数据不会丢。 |
| quickHint | Tired of typing it? Use Touch ID | 不想每次都输入？试试 Touch ID |

---

## 7. Tests

Automated tests cannot touch real Touch ID or Windows Hello. Chrome's virtual authenticator (CDP `WebAuthn` domain)
stands in for the authenticator. Real dialogs are manual checks.

### 7.1 Unit (Node; `platform/webauthn.ts` replaced by a fake that returns bytes)

- Known-answer vectors for `kek-prf` and `pin-cfg`. Labels distinct from every existing one.
- AAD swaps fail to unwrap: vault id, VK id, credential id, `armedAt`, `expiresAt`. The VK id is checked after the
  unwrap.
- PIN policy: lengths 3/4/8/9, non-digits, full-width digits accepted, repeats, runs, the common list.
- The counter:
  - the try is written before the derivation;
  - a crash between the write and the derivation still spends it;
  - two concurrent `unlockWithPin` calls spend two tries;
  - the 4th wrong PIN keeps `sk_quick`, the 5th deletes it;
  - success resets the counter to 5.
- Expiry: `now = expiresAt` passes; `expiresAt + 1` fails; a clock behind `armedAt` by more than 60 s fails; the alarm
  deletes the record.
- Soft and hard, per row of §5.5. Lock epoch: a lock during the PIN derivation or the WebAuthn ceremony voids the new
  session.
- Refusals: "always" mode refuses arming and setting a PIN, and sweeps an existing record; a device-key vault refuses;
  `verifyPassword` never accepts a PIN or PRF.
- Gate assertion check:
  - UV flag 0, UP flag 0, wrong challenge, wrong origin, `crossOrigin: true`, wrong `rpIdHash`, an altered signature and
    an unknown credential are each refused;
  - ES256 (DER → raw) and RS256 vectors are accepted.
- PRF: no `results.first` makes it `gate`, never `prf`. A vault or VK mismatch shows "turn back on" and records no
  `prf_failed`. A tampered wrap records `prf_failed`. 14 days: `lastPasswordAt` older than 14 days, or more than 1 day
  ahead, is refused.
- `VkRecord`s: rotation nulls PRF wraps and moves `sk_pin` (race test as `gm2-fixes.test.ts`); a join or start over
  with a new vault id clears everything.
- Read budget: the PIN unlock's `storage.local` reads ≤ the password unlock's. A password unlock with nothing enrolled
  is byte-for-byte as today.
- Secrets never logged: drive every path with a recording `onDiag`, security log and diagnostics sink, and assert that
  no PIN, PRF output, challenge or VK appears.
- Source rules (`source-rules.test.ts` style):
  - the string `sk_quick` appears only in `platform/session.ts` and is only passed to `chrome.storage.session`;
  - `navigator.credentials` appears only in `platform/webauthn.ts`;
  - nothing writes `sk_pin` or `sk_prf` outside their `VkRecord`s and the service.

### 7.2 End-to-end with the virtual authenticator (Playwright, `test/e2e/`)

```ts
const cdp = await context.newCDPSession(page);   // the extension page under test
await cdp.send("WebAuthn.enable", { enableUI: false });
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
  protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
  hasPrf: true, automaticPresenceSimulation: true,
  defaultBackupEligibility: false, defaultBackupState: false,
} });
```

The option names come from the CDP `WebAuthn.pdl` at tip of tree: `hasPrf`, `hasHmacSecret`, `isUserVerified`,
`defaultBackupEligibility`, `setUserVerified`, `removeCredential`, `setResponseOverrideBits` [transcribed]. The Chromium that Playwright 1.64.1 bundles supports `hasPrf`, `defaultBackupEligibility`, `defaultBackupState`,
`isUserVerified` and `setAutomaticPresenceSimulation` [verified with `tools/webauthn-probe/test/verify.mjs`,
2026-10-19]. `YUBIKEY-DESIGN.md` notes that `hasHmacSecret` needs Chrome 148+.

| Scenario | Set-up |
|---|---|
| Enrol with PRF, lock, unlock with the device. Then simulate a restart **in the same tab**: clear `chrome.storage.session`, which is all a restart does to Sixkey's state. The device unlock still works, and no gate or PIN is offered | `hasPrf: true` |
| Enrol without PRF: shows "until the browser closes". After the same simulated restart, only the password works | `hasPrf: false` |
| A UV failure is refused | `setUserVerified(false)` |
| The gate refuses a UV-less assertion (our own check, whatever Chrome does) | `setResponseOverrideBits({isBadUV: true})` |
| A synced passkey without the opt-in becomes a gate (no `wrap` stored). With the opt-in it gets a PRF wrap and the "Synced" mark | `defaultBackupEligibility: true, defaultBackupState: true` |
| The passkey was deleted in the OS: falls back to the password, and settings offers Remove | `removeCredential` |
| A cancel or timeout leaves no record and no log entry | `setAutomaticPresenceSimulation(false)` + abort |
| A security key is classed `security-key` (D25 rules apply) | `transport: "usb"` |
| Rotate keys, then "turn back on" with one confirmation | — |
| Shared preset: no PIN offered; switching to it ends quick unlock | — |
| Session PIN: set, soft lock, 4 wrong + 1 right; 5 wrong, then the password screen; a browser restart shows the password screen | — |

**Scope caveat.** A new browser process has no virtual authenticator, and a PRF secret cannot be copied into another
one: `addCredential` has no `hmac-secret` field [transcribed from the `.pdl`]. The probe's check
(`tools/webauthn-probe/test/verify.mjs`, Playwright 1.64.1's bundled Chromium, 2026-10-19) also showed that an
authenticator that is **not removed explicitly still answers for a later page of the same browser** [verified there].
So:

- every test removes its authenticator (`removeVirtualAuthenticator`, then `WebAuthn.disable`) before the next one;
- no automated test restarts the browser and expects a device unlock afterwards: it would fail for a reason unrelated to
  Sixkey. The real restart is manual check §7.4 item 3;
- enrol and unlock in the **same tab**, navigating it between `options/index.html` and `popup/index.html` (the harness
  already opens the popup as a tab);
- run the `?mode=window` ceremony in place in the test build;
- leave the real small window and the real toolbar popup to the manual checks.

### 7.3 Mutation targets (what the tests above must kill)

1. Decrement moved after the derivation, or out of the lock.
2. `triesLeft <= 0` changed to `< 0`; 5 changed to 6.
3. Expiry `>` changed to `>=` or dropped; the clock-back check dropped.
4. `sk_quick` written to `storage.local`.
5. The "always" mode or device-key vault refusal removed.
6. Any AAD field dropped.
7. The VK id check after the unwrap removed.
8. A soft lock clearing `sk_quick`, or a hard lock not clearing it.
9. The `startSession` epoch read after the ceremony instead of before.
10. `verifyPassword` accepting a quick path.
11. Each assertion-check clause.
12. `prf.enabled` used instead of `results.first`.
13. The BE check inverted.
14. The 14-day comparison flipped.
15. `pin_failed` not recorded.
16. The `VkRecord` writing outside `webLock`.

### 7.4 Manual checks to add to OWNER-DECISIONS/12 (real hardware)

On a MacBook with Touch ID (macOS 15+, iCloud Keychain on, and once off) and a Windows 11 PC (with and without
KB5077181, Windows Hello face or fingerprint, and the Windows PIN fallback):

1. Enrol Touch ID and Windows Hello. Note which provider Chrome's dialog offers, the PRF result (the settings list shows
   "after restarts" or "until the browser closes"), and the "synced" mark.
2. Open the **real toolbar popup**:
   - the OS dialog appears, the popup stays (or the window opens), and the codes show;
   - Esc in the OS dialog leaves you at the password field;
   - the OS's own fallback (Mac password, Windows PIN) works.
3. Restart the browser: the device unlock still works (PRF), or the password is required (gate or PIN).
4. Lock the screen and come back: the PIN or gate reopens Sixkey. After 12 h, or after 5 wrong PINs, the password is
   required.
5. Delete the passkey in the OS (Passwords app / Windows Settings › Accounts › Passkeys): Sixkey falls back without
   error, and Remove works.
6. Switch to the shared mode: the PIN disappears, and the device unlock is asked at every opening.
7. The dialog's requester name (expected "chrome-extension") matches the window's sentence.
8. Linux and ChromeOS: no device button is offered; the PIN works.

---

## 8. Staged plan

| Stage | Content | Size | Depends on | Risks |
|---|---|---|---|---|
| **0 Probe** | **Built 2026-10-19:** `tools/webauthn-probe/`, a separate dev-only extension, never part of `extension/` or its builds; checked against the virtual authenticator (9 scenarios in 0.1.2, including largeBlob/credBlob and signature determinism) and by Node unit tests (7). **Mac runs 1 (GPM) and 2 (iCloud Keychain) done (§0A).** Mac run 3 (Chrome profile, device-bound, no PRF) done. Pending: blob and signature tests (0.1.2), the attachment/hints variations, restart, auto-start, and Windows. After each run: delete the test passkey (run 1's is in the owner's Google Password Manager, run 2's in iCloud Keychain). For Windows Hello, iCloud Keychain, Chrome-profile Touch ID and GPM: extension-origin RP ID; PRF on `create` and `get`; BE/BS; resident vs non-resident on Windows; popup survival; auto-start without a click; the dialog's requester name. Results go into this document, revision 1 | 1 day + 1–2 days of platform runs | owner's Mac and a Windows 11 PC | RP ID refused → conditional question (§0.5); popup closes on some OS → window there |
| **1 Session PIN and quick lock** (first, owner priority 2026-10-19; built and merged, notes `docs/design/notes/QUICK-PIN-NOTES.md`) | `sk_quick`, `sk_pin` (`pin.ts`, the `VkRecord`), soft and hard locks (§5.5), the 5-try counter, the 12-hour cap and expiry alarm, the PIN field in the popup, the PIN settings box; the quick lock of §5.12 (Lock now, the `lock` command in the worker, open pages reacting to the epoch, lock when the popup closes, the `profile` marker); security-log kinds `pin_*` and `quick_ended`; tests §7.1 (PIN parts), §5.12 item 6 | **M** (about 1.5 weeks) | Q1 decided | the honesty of labels (review the copy); counter races (tests §7.1); the manifest change for the command (`check-dist`) |
| **2 Device unlock** (PRF and gate) | `prf.ts`; `sk_prf` with `kind`, `mode`, `synced`; `VkRecord`; enrolment that classifies `prf` or `gate`; the synced opt-in; the gate's assertion check (`assertion.ts`); the 14-day rule; the "Ways to unlock" box; the lock-screen button in the popup (enrolment in a tab, §0A.5 item 3); security-log kinds `prf_*`; YR-24; virtual-authenticator e2e; unit tests | **M** (about 2–2.5 weeks) | Stage 1's session layer (for the gate); Q2, Q3 decided; Stage 0's Windows run for the Windows half | Windows build fragmentation; a Chrome change to extension RP IDs; the popup budget (lazy chunk mitigates) |
| **3 Polish and docs** | first-run step (§0A.5 item 4), popup hint, the device-key card sentence, catalog split or budget raise, `local-vault.md` and `PRIVACY.md` sections, manual checks run | **S** (about 1 week) | 1, 2 | full-catalog budget |
| **4 Security keys** | `YUBIKEY-DESIGN.md` C (Y3) on the same records and UI (`kind: "security-key"`, D25 rules) | **S** beyond Stage 2 (Y3's estimate was 2–3 weeks standalone) | 2; Y1/G1 | as in `YUBIKEY-DESIGN.md` |

**Release-order constraints** (from §0A item 5):

- dev builds get a fixed `key` in `manifest.dev.json` before Stage 2's manual tests;
- the store extension ID must be final before the device unlock reaches users;
- the ID never changes afterwards without a migration plan. A change loses no data, but strands every enrolment.

**Ordering (revised 2026-10-19).** The owner put the PIN first, so the session layer comes first. The device unlock
then adds the gate (on that layer) and the PRF unlock together, because on macOS the gate is the default biometric
experience (§0A.5 item 5). Stage 0 continues in parallel and must report Windows before Stage 2's Windows half is
finished.

Total about 5–6 weeks for stages 0–3 [estimate].

---

## 9. Owner questions and answers

| # | Question (as asked) | Recommendation | Owner's answer (2026-10-19) |
|---|---|---|---|
| **Q1** | Reopen SYNC-DESIGN §13 F25 for a **memory-only** session unlock (Touch ID / Windows Hello without PRF, and the Sixkey PIN as the fallback)? | **Yes**, ending at browser restart, at most **12 h** after the master password, after 5 wrong PINs, and with any key change; never in the shared mode. A PIN that survives a restart stays rejected (§1.7). | **Yes**, for the memory-only form only, covering both the PIN and Touch ID / Windows Hello without PRF (confirmed the same day). |
| **Q2** | Amend `YUBIKEY-DESIGN.md` D25 ("security keys only") for platform authenticators: device-bound (Windows Hello) **yes**? Synced passkeys (iCloud Keychain, Google Password Manager, third-party providers) for the **persistent** unlock: yes, labelled, or no (then they are session-only)? | Device-bound: yes. Synced: yes, with the label of `quickOnPrfSynced`. | **Windows Hello: yes. Synced passkeys across restarts: only as an opt-in, off by default,** turned on by the user after a clear plain-language notice that it puts a passkey in Apple's or Google's cloud (§5.3 step 3). |
| **Q3** | How often should the persistent device unlock ask for the master password? | **Every 14 days**, as `YUBIKEY-DESIGN.md` D17, enforced in the service | **Yes, 14 days.** |
| Q4 (only if Stage 0 fails) | If Windows Hello or iCloud Keychain refuse the extension-origin RP ID: use RP ID `sixkey.app` (host permission kept granted, weaker isolation, §1.6), or offer only the session gate there? | Session gate only, and revisit | open; asked only if Stage 0 fails |

---

## 10. Changes other documents need

**Done on 2026-10-19:** dated notes recording Q1 and Q2. Each was added inside an existing line, so line citations
elsewhere stay valid; nothing earlier was rewritten.

- `docs/SYNC-DESIGN.md`: §13 F25 row, §12 Q4 row.
- `docs/design/proposals/YUBIKEY-DESIGN.md`: §0.00 Q2 row, D25 row, §1.2.2 step 3, §7.4 Q2 row.
- `docs/research/fingerprint-browser-security-lessons.md`: F25 row of the decision table.

**Still to do**, by each document's owner, when the stages land:

- `docs/SYNC-DESIGN.md`: add the per-device `sk_prf` / `sk_pin` / `sk_quick` to §2.5's list of local-only state and
  §3.11's lock table ("soft-locked counts as locked"). Add `sixkey/v1/pin-cfg` to §2.2 if it becomes a shared label (it
  is local-only).
- `docs/design/proposals/YUBIKEY-DESIGN.md`:
  - §1.2.1's record gains `kind`, `mode` and `synced`;
  - D16's "always a window" holds for security keys, while platform authenticators follow Stage 0;
  - §5.1 R8, so that one security-log version bump covers both features.
- `docs/security/local-vault.md`: a "Quick unlock" section. Add rows to "What is protected" (device unlock with and
  without PRF, PIN, synced passkeys). Add a line under "Locking" for soft and hard locks.
- `docs/PRIVACY.md`: what `sk_prf`, `sk_pin` and `sk_quick` hold. Nothing is sent. The OS and the passkey provider
  (Apple, Google, Microsoft) keep the credential, and a synced one syncs through them.
- `docs/ARCHITECTURE.md` §3: the new keys. `docs/README.md`: list this proposal.
- `OWNER-DECISIONS/12-manual-checks.md`: §7.4. (Q1–Q3 are decided, so they need no `OWNER-DECISIONS` file.)
- `docs/research/ux-study.md` §2.6: a pointer here (its PIN rejection stands for stored PINs).

---

## 11. Unverified claims and sources

### 11.1 Unverified

1. No `chrome.*` API exposes the OS re-authentication (inferred; not exhaustively checked).
2. Chrome's saved-password encryption uses DPAPI / app-bound keys on Windows and the Keychain on macOS, and covers
   neither `storage.local` nor IndexedDB.
3. A non-extractable `CryptoKey` in IndexedDB is stored with its raw key material; byte format not re-read.
4. `storage.session` content can reach the swap or hibernation file.
5. Windows Hello PRF:
   - which builds (KB5077181 and later) and which Chrome version reports it on `create()`;
   - whether `get()` returns `results.first` without it having been requested at creation;
   - Windows 10 absence;
   - BE = 0 for Windows Hello passkeys;
   - whether Windows Hello credentials are always discoverable;
   - whether Windows Hello commonly uses RS256.
6. Third-party providers' PRF; Linux GPM availability; ChromeOS; credBlob / largeBlob on the Chrome-profile
   authenticator, and where Chrome stores such a blob. (**Now verified** on macOS 27 + Chrome 154, §0A: GPM and iCloud
   Keychain have PRF; the Chrome-profile authenticator has none.)
7. Windows Hello (`webauthn.dll`) accepts the RP string `chrome-extension://<id>`. (**Now verified** for GPM and iCloud
   Keychain on macOS, §0A.)
8. On Windows, a native process can call `webauthn.dll` for a Windows Hello credential with another program's RP
   string.
9. The toolbar popup survives a platform-authenticator dialog on Windows; `get()` works with no interaction at all
   since the page opened. (**Now verified** on macOS 27 + Chrome 154, §0A: `get()` survives in the popup with all three
   providers; `create()` survives with GPM and iCloud Keychain, but **not** with the Chrome-profile authenticator; `get()`
   needs no fresh transient activation.)
10. `isUserVerifyingPlatformAuthenticatorAvailable()` and `getClientCapabilities()` results per platform; the Signal
    API with an extension-origin RP.
11. ~~Virtual authenticators are scoped to one tab~~: contradicted. An authenticator that is not removed still answers
    for a later page of the same browser. `hasPrf` works in Playwright 1.64.1's bundled Chromium (both checked
    2026-10-19 with `tools/webauthn-probe/test/verify.mjs`).
12. Argon2id GPU rates; rented GPU prices.
13. Developer tools on extension pages are available to anyone at the browser unless a policy turns them off.

### 11.2 Sources

- This repository [verified]:
  - `extension/src/core/{crypto/kdf.ts, crypto/keyring.ts, service/service.ts, service/types.ts, service/presets.ts, sync/local/keys.ts}`;
  - `src/platform/session.ts`, `src/background/sw.ts`, `src/popup/screens/Locked.tsx`,
    `src/options/{Security,SecurityMode}.tsx`;
  - `scripts/check-dist.mjs` and its output on the current `dist/`;
  - `test/unit/read-budget.test.ts`, `_locales/*/messages.json`;
  - `docs/{SYNC-DESIGN.md §1.2, §2.1, §3.11, §6, §7, §12, §13; security/local-vault.md; ARCHITECTURE.md; research/ux-study.md §2.6; design/proposals/YUBIKEY-DESIGN.md}`;
  - `docs/history/PLAN-zh.md` §5.1.
- Chromium source, GitHub `main` (2026-10-19) [verified]: `chrome/browser/device_reauth/mac/authenticator_mac.mm`,
  `chrome/browser/device_reauth/win/authenticator_win.cc`. `chrome_web_authentication_delegate.cc` as cited in
  `YUBIKEY-DESIGN.md` §1.2.6.
- CDP `WebAuthn.pdl`, tip of tree: https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/WebAuthn.pdl [transcribed].
- Corbado, "Passkeys & WebAuthn PRF" (tables "Status: August 2026"): https://www.corbado.com/blog/passkeys-prf-webauthn [transcribed, vendor].
- Bitwarden help, "Unlock with biometrics": https://bitwarden.com/help/biometrics/ ; "Log in with passkeys": https://bitwarden.com/help/login-with-passkeys/ [transcribed, vendor].
- Bitwarden community, "Encryption (PRF) via Windows Hello passkey": https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236 [transcribed, user reports].
- Mozilla bug 2026687, comment 4 on Chromium's popup behaviour: https://bugzilla.mozilla.org/show_bug.cgi?id=2026687 [transcribed, third-party claim].
- W3C public-webauthn, "Chrome extensions will be able to claim WebAuthn site RP IDs" (2023-12): https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html [transcribed].
- MDN, "Use Web Authn API in web extensions": https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api [transcribed].
