# YubiKey design (docs/design/proposals/YUBIKEY-DESIGN.md) adversarial review

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading, repository paths updated to the current layout and absolute local paths
> shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

> Date: 2026-10-16. Review only. No file was changed except this one; nothing was run against hardware.
>
> **Read in full:** `docs/design/proposals/YUBIKEY-DESIGN.md` (942 lines).
>
> **Inputs read:**
> - `research/yubikey-oath-feasibility.md`: §1, §2.5, §3, §4.4 and the sources.
> - `research/mcp-feasibility.md`: B3, B5–B8 and the (a) row.
> - `research/ux-study.md`: §2.6, C7, C15 and appendix A.
> - `research/fingerprint-browser-security-lessons.md`: the isolation section.
> - `SYNC-DESIGN.md`: §0.0i, §0.0j, §1.2 (A3, A10), §1.3, §2.3, §3.9, §3.11, §3.13, §3.14, §4.3, §4.4 and §13.
> - `SECURITY.md`.
>
> **Code read:**
> - Vault: `core/vault/{model,validate,merge,ops}.ts`.
> - Crypto: `core/crypto/keyring.ts`.
> - Storage: `core/storage/store.ts` (`openVault`, `tryOpen`).
> - `core/service/service.ts`: the `VkRecord` contract, `currentVk`, `startSession`, `unlockWith`/`finishUnlock`, `finishKeyChanges`, `importBackup` and `purgeForever`.
> - Other core: `core/service/{presets,security-log}.ts`, `core/import/dedupe.ts`, `core/backup/{backup,subset}.ts` and `core/sync/crypto/keybundle.ts`.
> - Platform: `platform/session.ts`.
> - Pages: `options/{Backup,Security,FirstRun,Rail}.tsx`, `popup/main/AddConfirm.tsx` and `ui/{otp,hooks}.ts`.
> - Build and tests: `scripts/{check-dist,store-id}.mjs`, the three manifests, `test/e2e/{smoke.spec,harness}.ts` and `test/unit/read-budget.test.ts`.
>
> **External facts:** checked in three research passes against primary sources. These were Chromium `main` on GitHub, developer.chrome.com, Chrome Enterprise policy, the W3C WebAuthn and FIDO CTAP specs, Microsoft `webauthn.h`, the Yubico YKOATH spec, the yubikit / ykman / yubioath-flutter source and the ykneo-oath applet source. Section 4 lists them with links.
>
> **Markers:**
> - **[verified]**: primary source read.
> - **[summary]**: secondary source or search summary only.
> - **[inferred]**: reasoning, not a source.
> - **[unverified]**: could not be checked.
>
> Section references like "§3.3" are to YUBIKEY-DESIGN.md unless another file is named.

---

## 0. Verdict

**READY AFTER FIXES.**

The architecture is sound and the main trade-offs are stated honestly. That covers the read-only allowlisted helper, the helper-owned clock, the OATH-password split, references in place of seeds, PRF wraps outside the keyring, extension-ID RP ID behind a prototype gate, and the master password that is never replaced.

The fixes fall into three groups. None of them needs a redesign:

- **One false security claim.** The shared/automated preset is presented as turning A off for the attacker it targets (YR-1).
- **Two protocol details that must be settled before the helper protocol is frozen.** One is a status-word collision (YR-3). The other is an OATH session model that is per card, not per process (YR-4).
- **Two missing checks or plans.** Synced passkeys are not excluded from C (YR-6), and there is no kill switch for a bad helper release (YR-5).

Several "no future codes" statements are also wrong for HOTP (YR-2). The owner must decide whether HOTP stays in v1.

**C (PRF unlock)** can start Y3 after G1, with two additions:
- YR-6 (reject synced passkeys).
- YR-28: G1 must also test discoverable against non-discoverable credentials on Windows, and gate on the get() result, not on `prf.enabled`. **A** should not freeze its protocol (Y4 → Y5b) until YR-3, YR-4 and YR-10 are written into §3.3.

Counts and the top 3 are in §6. The M2 list is in §7.

---

## 1. Confirmed flaws

Each finding gives where it is, the failing sequence, the fix, and whether it blocks implementation.

### YR-1 (High): the shared/automated preset does not turn A off for A10, but the design and the draft SECURITY text say it does

**Where:**
- D20.
- §1.1.1, last paragraph.
- §5.4.
- §4.6 draft, first bullet: "(the 'shared / automated' mode turns it off)".
- §5.3, the FINGERPRINT-BROWSERS text.
- §4.5 A11 mitigation: "共享/自动化预设关闭 A".

**Contradicted by the design itself:** §4.1 bullet 4 and N6 admit that removing the permission "不是一道硬闸".

**Facts (§4, N2–N3) [verified]:**
- **Removal is soft.** `permissions.remove` calls `RevokeOptionalPermissions(..., PermissionsUpdater::RemoveType::kSoft, ...)`. `permissions_updater.h` says: "kSoft: Permissions will be removed from the active set of permissions, but not the stored granted permissions. This allows the extension to re-add the permissions without further prompting." It also says: "kHard is only exercised in unit tests".
- **Re-requesting does not prompt.** The request path says: "We don't prompt for already-granted permissions since these were either granted to an earlier extension version or removed by the extension itself (using the permissions.remove() method)."
- **The gesture check is satisfiable from CDP.** The gesture check is `if (!user_gesture() …) return Error("This function must be called during a user gesture")`. CDP `Runtime.evaluate` and `callFunctionOn` take `userGesture: true`, which Blink turns into `NotifyUserActivation(..., kDevTools)`. That works in an extension page; it probably does not work in the SW [inferred from code].

**Failing sequence:**
1. In a fingerprint-browser profile, the user turns A on in the standard preset and installs the helper. The install is machine-wide and system-level, which D18 requires.
2. Later the user answers "shared / vendor-synced / script-controlled", or picks the shared preset. Sixkey calls `permissions.remove`, and the panel now says "YubiKey 验证码不可用".
3. Sixkey is locked. The vendor's local API or an agent (A10) opens any Sixkey page (`Target.createTarget` on `chrome-extension://<id>/options/index.html`) and runs `Runtime.evaluate({expression: "chrome.permissions.request({permissions:['nativeMessaging']})", userGesture: true})`. The permission returns with no UI.
4. `chrome.runtime.connectNative("app.sixkey.oath")` → `hello` → `keys` → `codes`. These are current codes for every credential on the inserted key that needs no touch and has no password, in exactly the profile the preset was meant to protect.

**Variants:**
- **Never granted in this profile.** Chrome shows its permission dialog. A CDP-only client probably cannot click browser UI [inferred]; an OS-level agent can.
- **Machine-wide reach.** The helper serves every profile on the machine that has the store-ID Sixkey: all fingerprint-browser profiles and all Chromium brands whose lookup finds it.

**Fix:**
1. Rewrite D20, §1.1.1, §5.4, §4.5 A11, §4.6 and §5.3 to say what the preset really does: "it removes the permission. Anything that controls this browser can turn it back on without a prompt if it was ever granted in this profile." The hard protections on a machine with shared or automated profiles are these: do not install the helper there, do not leave the YubiKey inserted, or put the accounts behind touch or an OATH password.
2. When the shared preset is applied with A on, show that text and link to the helper's uninstall steps.
3. As a detective control only, listen to `chrome.permissions.onAdded` in the SW and write `oath_on` to the security log (R8). The grant then leaves a trace even when it bypasses Sixkey's UI. Say plainly that an attacker running code in the SW can suppress it.
4. Do not offer "enable A" in a profile whose first-run answer was shared/automated (already in §5.4). This is UX only.

**Blocks implementation:** no. It blocks G4 (SECURITY/PRIVACY text) and the D20 rationale.

### YR-2 (Medium): HOTP gives A10 long-lived codes, so "only the current code, no future codes" is false

**Where:**
- §0 item 1 ("所以谁都拿不到'未来的码'").
- D5.
- §3.3 `code` ("HOTP：空挑战，计数前进").
- §4.5 A11 residual: it only says "能把 HOTP 计数器往前推".
- N4, N5.
- §4.6: "can only list accounts and compute the *current* code".
- Q5, which recommends HOTP in v1.

**Facts:**
- CALCULATE on a HOTP credential returns the next code and advances the key's counter (yubikit `calculate_code` [verified]).
- A HOTP code stays valid at the service until a later counter value is accepted. This is RFC 4226's look-ahead [verified, RFC behaviour].
- CALCULATE ALL returns tag `0x77` for every HOTP credential, whether or not it needs touch. yubikit maps anything that is not `0x77` to TOTP; ykman's CLI says "HOTP might require touch, we don't know. Assume yes after 500ms" [verified]. So neither the helper nor the extension can know whether a HOTP credential is touch-protected. That also makes the `ref.touch` hint (§2.1) meaningless for HOTP.

**Failing sequence:**
1. A key holds a HOTP credential without touch (common for HOTP set up by ykman or older tools).
2. Sixkey is locked. A10 calls `code` for it once a second per helper process, opening more ports to go faster (N5).
3. Each code is a working second factor that stays valid until the user's next HOTP login. If the attacker uses one first, the user's next codes are rejected until the counter is resynchronised.

That is a stored second factor, not a 30-second one, and none of the text says so.

**Fix:**
- Owner decision (Q5). Preferred: no HOTP in v1. Alternative: a per-entry opt-in, with the text "anything that controls this browser can generate and keep codes for this account".
- There is no helper-side mitigation, because touch is unknowable for HOTP.
- Correct §0, D5, A11 and §4.6 to say "no TOTP code for a time step other than now or the next one; a HOTP code is always usable later".

**Blocks implementation:** no (owner decision and text).

### YR-3 (Medium): a touch timeout returns `0x6982`, the same status word as "authentication required"; §3.3 maps it to `locked`

**Where:**
- §3.3 rule "PC/SC: …钥匙回 `6982`（需要鉴权）→ 助手回 `locked` 并附新挑战 → 扩展重新 `unlock`".
- The error codes `locked` (`6982`) and `touch_timeout`.
- §1.1.3: "超时显示'没有检测到触碰，再试一次'".

**Facts [verified]:**
- ykman: `if e.sw == SW.SECURITY_CONDITION_NOT_SATISFIED: raise CliFail("Touch account timed out!")`. `SECURITY_CONDITION_NOT_SATISFIED` = `0x6982`; `0x6985` is a different code.
- yubioath-flutter tells the two cases apart only by elapsed time: `if e.sw == SW.SECURITY_CONDITION_NOT_SATISFIED and time() - start > 5`.
- A wrong VALIDATE response gives `0x6A80`. The spec's `0x6984` for VALIDATE means "auth not enabled" (ykneo-oath source; yubioath-flutter treats `0x6A80` as wrong key).
- The OATH touch timeout length is not documented anywhere I could find [unverified].

**Failing sequences:**
- **Key without a password.** The user clicks a touch row and does not touch. The key times out with `6982`, and the helper reports `locked`. SELECT returns no challenge, so the extension shows "这把 YubiKey 设了密码" for a key that has none.
- **Key with a password and K remembered.** The extension silently re-VALIDATEs and retries the CALCULATE. The key blinks again, which turns into a loop of touch prompts. That also trains the user to touch whenever the key blinks (N2).

**Fix:** write the status-word mapping per command into §3.3 and test every row against the mock applet:

| Command | Status word | Maps to |
|---|---|---|
| VALIDATE | `6A80` | `wrong_password` |
| VALIDATE | `6984` | `no_password_set` |
| LIST, CALCULATE ALL, or CALCULATE on a non-touch credential | `6982` | re-SELECT; `locked` only if SELECT returns a challenge |
| CALCULATE on a touch or HOTP credential | `6982` | `touch_timeout`, by elapsed time ≥ a threshold and the credential kind |

Never retry a touch CALCULATE automatically.

**Blocks implementation:** yes, for the protocol freeze (Y4/Y5b). It is cheap.

### YR-5 (Medium): no incident-response path for a compromised helper release (A13)

**Where:** §3.10, §3.11, §4.5 A13, N11 and §7.3 G3.

**Failing sequence:**
1. A signed release, say 1.3.0, turns out to be malicious: a compromised vendored dependency or a misused signing pipeline.
2. It is installed system-wide.
3. Chrome launches it on every `connectNative`, that is, on every popup open with A on and a key entry in the vault, before any `hello`. So the extension cannot screen by version: launching it is already the harm.
4. By design there is no helper update channel, and the design has no plan to reach users.

**Fix:** write the plan before G3.
1. **Kill switch.** Each extension version carries a compiled-in switch: "never call `connectNative`", or "only for helpers released after date X". When it is on, the YubiKey module shows a persistent notice in the popup and in settings with uninstall steps. Store auto-update delivers it.
2. **Say why version denylists are not enough.** A check after `hello` runs too late.
3. **Revocation.** Revoke the Apple Developer ID certificate or notarization ticket and the Authenticode certificate. Their effect on binaries that are already installed and not quarantined is limited [inferred]; say so. Rotate the Linux repository key.
4. **Advisory.** Publish an advisory on the download page.
5. **Self-check.** Add a `--version` flag so users can check what they have.

**Blocks implementation:** no. It is required before G3.

### YR-6 (Medium): C does not exclude hybrid or synced passkeys, so Q2 ("security keys only") and A16 are unenforced

**Where:**
- §1.2.2 step 2: `authenticatorAttachment: "cross-platform"`, `hints: ["security-key"]`, `residentKey: "discouraged"`.
- Q2, A16, P15.

**Facts:**
- Hybrid (phone) authenticators count as cross-platform, and `hints` are only hints [summary; see §4 W-rows].
- Phone passkey providers create discoverable, synced credentials, and current Android (Google Password Manager) and iOS 18 providers support PRF [summary].
- Whether a phone accepts a non-domain RP ID over hybrid is [unverified].

**Failing sequence:**
1. In "添加安全密钥", Chrome's dialog offers "Use a phone or tablet", and the user picks it.
2. A synced passkey is created, `prf.enabled === true`, and `sk_prf` stores it.
3. Anyone with the user's Google or Apple account plus a profile copy can now unlock: the P15 "future" risk exists in v1.

**Fix:** after `create()`, reject the credential (and save nothing) in any of these cases:
- the backup-eligible flag BE (`0x08`) is set in `response.getAuthenticatorData()`;
- `getTransports()` contains `"hybrid"` or `"internal"`;
- `credential.authenticatorAttachment !== "cross-platform"`.

Keep the hint. Add this to G1. Test it in e2e with a CDP virtual authenticator created with `defaultBackupEligibility: true` (a `VirtualAuthenticatorOptions` field [verified, WebAuthn.pdl]) and assert that nothing is saved.

**Blocks implementation:** yes, for Y3. The check is small.

### YR-7 (Low): the A17 comparison is wrong, though the conclusion survives

**Where:** §4.5 A17 ("后门没有比'知道主密码'更多") and P4.

**Problem:**
- A password change revokes knowledge of the old password, at least against clean copies. It does not remove an enrolled authenticator.
- The right bound is "A10 while unlocked already knows VK". VK also survives a password change, and only "rotate key" kills both. The design already nulls PRF wraps on rotation (§1.2.5).

**Failing sequence:**
1. A10 enrols a virtual authenticator while the vault is unlocked.
2. The user suspects a leak and changes the master password, which is the natural reaction.
3. The user believes they are safe. A later profile copy still opens with the attacker's authenticator, and with the VK it already read.

**Fix:**
- The password-change screen lists enrolled security keys and says "changing the password does not remove these; to lock out anyone who may have seen your unlocked vault, rotate the key".
- Correct the A17 and P4 wording.

**Blocks implementation:** no.

### YR-8 (Low): removing a lost key's enrolment does not erase it from disk, so "不必轮换 VK" is too strong

**Where:** §1.2.4, "钥匙丢了".

**Fact:** SECURITY.md "Limits": LevelDB keeps overwritten values until it compacts.

**Failing sequence:**
1. The key is lost, and its PIN may be known (it was typed under observation).
2. The user removes the enrolment.
3. A profile copy taken days later can still hold the old `sk_prf` bytes. The VK was not rotated, so that copy, the key and the PIN together give the current VK.

**Fix:** "移除" for a lost key offers "also rotate the vault key", pre-checked when the user says the PIN may be known. The text mirrors SECURITY.md's residue paragraph.

**Blocks implementation:** no.

### YR-9 (Low): "nobody can get future codes" holds only for callers that go through the genuine helper

**Where:** §0 item 1 and §4.6 ("can only … compute the *current* code").

**Fact:** CALCULATE answers any challenge (yubikit `_get_challenge`, `calculate_code`; the feasibility study §1.1 [verified]).

**Who can still get future codes:**
- Any same-user process that uses PC/SC directly.
- A shadowing helper (§3.8).
- Anyone holding a HOTP credential (YR-2).

**Fix:** reword to "nothing that goes through Sixkey's helper can get a TOTP code for a step other than now or the next one". The A12 row already describes the rest.

**Blocks implementation:** no.

### YR-12 (Low): the Linux build plan contradicts itself

**Where:**
- §3.11: "Linux 用 musl 静态构建".
- §3.9: the `.deb` depends on `pcscd, libpcsclite1`.
- §3.4: the import-table check "Linux 不得引用 `getaddrinfo`…（`socket`/`connect` 允许，因为 libpcsclite 需要）".

**Problem:**
- A static musl binary cannot load the distro's glibc `libpcsclite.so`.
- It has no dynamic import table to check.
- Once stripped, it has no symbol names either.

**Fix:** choose one.
- **(a) Dynamic glibc build.** Build in a container pinned by image digest. Depend on `libpcsclite1`. Check `DT_NEEDED` and the undefined symbols.
- **(b) Static musl build with a vendored pcsc-lite client.** pcsc-lite's client library is BSD-style [summary]. Test client↔pcscd protocol compatibility on each supported distro. Check symbols before stripping.

Rewrite the §3.4 row to match.

**Blocks implementation:** no (Y4).

### YR-13 (Low): the §2.11 change list misses sites that use `secret` for identity or counting

TypeScript's discriminated union will flag every `e.secret` read. A spread such as `{...e, secret: ""}` (`ops.ts` `purgeEntry`, `clampVault`) will not be flagged. More importantly, each site needs a decision, and the design does not make it.

| Site | Today | Needs a decision |
|---|---|---|
| `service.ts:834–840` `importBackup`, "added" mode (a backup of another vault) | dedupes on `secret+issuer+label`; `addEntry({secret: e.secret})` | Add key entries as references, deduped by `ref.name` (+ `keys`)? §2.5 has no row for "import a full backup of another vault" |
| `service.ts:857` `purgeForever` filter `e.secret !== ""`; `ops.ts:111` `restoreEntry` guard; `ops.ts:119` `purgeEntry` | keeps `kind`/`ref` through the spread | The purge must drop `kind`/`ref` (the §2.3 tombstone); add a test that a purged key entry serializes as v1 |
| Counts: `FirstRun.tsx:29`, `Backup.tsx:300`, `Rail.tsx:36` (`secret !== ""`) | count live and trashed entries | Count key entries (yes) |
| `Security.tsx:52` residue warning ("re-issue those accounts' 2FA keys") | any non-empty secret | Key entries have nothing to re-issue: exclude them |
| `popup/main/AddConfirm.tsx` + `dedupe.ts` `verdictOf` | a soft account with the same issuer/label as a key entry → "rebind" → `addOrReplace` trashes the key entry | Allow it? (Trash only, so no data loss, but the user loses the key reference silently.) See also YR-20 |
| `ui/otp.ts` `canGenerate`/`codeFor`, `ui/hooks.ts` `keyOf` (`e.id + e.secret`), `importer.ts:206` (plain export), `migration.ts:212` | software-only | Listed generically in §2.11 ("TOTP 生成", "明文导出"); name them |

**Blocks implementation:** no. Add the rows before Y5a.

### YR-14 (Low): the 14-day rule is a reminder, not a control; make it consistent and budget it

**Where:** D17, §1.2.1 (`lastPasswordAt` in plaintext `sk_prf`) and §1.2.3.

**Problems:**
- It is enforced only by which button the lock screen shows.
- Anything that can write `chrome.storage.local` (A10, or the holder of a profile copy) or roll the clock back can extend it. Opening `popup/index.html?mode=window` directly may skip the screen's logic.
- It adds an `sk_prf` read to the lock screen and an `sk_prf` write to every password unlock. That runs against `test/unit/read-budget.test.ts` (unlock ≤ 8 local reads) and against the invariant in `service.ts` `unlockWith`: "A successful password unlock reads and writes nothing more than before".

**Fix:**
- Call it a reminder in D17 (that is what it is).
- Enforce it in the service's PRF unlock: refuse when the time is stale or more than one day in the future.
- Write `lastPasswordAt` only when an enrolment exists, and at most once a day.
- Raise the budgets explicitly, with a comment.

**Blocks implementation:** no.

### YR-16 (Low): Edge is listed as supported, but `allowed_origins` holds only the Chrome Web Store ID

**Where:** §3.6, §3.7 (the Edge rows) and §5.5.

**Problem:** a Sixkey installed from Edge Add-ons gets a different ID, so it hits `host_forbidden`.

**Fix:** either say "Edge: only with Sixkey installed from the Chrome Web Store", or add the Edge store ID. If you add it, `scripts/store-id.mjs` stops being "the one place it is written down".

**Blocks implementation:** no.

### YR-19 (Low): "remember the key's password" stores a full password equivalent; the profile-copy exposure is not stated, and `sk_oath` has no AAD

**Where:** §1.1.5, D6 and §2.10.

**Problems:**
- K is everything VALIDATE needs. Once validated, a session can PUT, DELETE and SET CODE.
- K is readable by anything that holds VK:
  - A10 while unlocked: stated.
  - **A profile copy plus the master password (A3): not stated.** With the physical key, that means reading and modifying the password-protected accounts.
- §2.10 gives `sk_oath` no AAD.

**Fix:**
- Add the A3 line to §1.1.5 and §4.5.
- Make the AAD `"sixkey-oath|1|{vaultId}|{vkId}"`.
- Keep "remember" off by default, as it already is.

**Blocks implementation:** no.

### YR-20 (Low): adding from the YubiKey ignores a software copy of the same account, which invites deleting the only backup

**Where:** §1.1.2 steps 1–5 (only "已添加" against existing references) and §2.6.

**Failing sequence:**
1. The user has `GitHub:alice` as a software entry. Its seed is backed up.
2. The user adds the same account from the key.
3. Now there are two rows. The user deletes the software row "because it is on the key".
4. The only Sixkey-held copy of the seed goes to the trash and is later erased. A lost key then means account recovery at GitHub.

**Fix:** when an issuer/label matches a live software entry, show "You also have this account in Sixkey with its key. Keep it: it is your backup." When the software row of such a pair is deleted, warn.

**Blocks implementation:** no.

### YR-24 (Info): `webauthn-prf` stays valid in local keyrings although D12 never uses it

**Where:** §1.2.1 ("留着无害"), and in code `keyring.ts:12, 41, 122`.

**Facts:**
- `validateKeyring` accepts a `webauthn-prf` wrap with no `kdf`.
- R4's bundle rule is already enforced: `sync/crypto/keybundle.ts:56` "wraps must be exactly password and recovery".

**Problem:** a junk local `webauthn-prf` wrap still counts for `removeMethod`'s "cannot remove the last way to unlock" rule.

**Fix:** remove the value from `METHODS` in the change that introduces `sk_prf`. No keyring has ever contained it.

**Blocks implementation:** no.

### YR-25 (Low): derive `schemaVersion` at serialization, not as a stored field

**Where:** §2.2 and the §2.11 `merge.ts` row.

**Problems:**
- Ops build vaults by spreading: `{...v, entries}` in `addEntry`, `replace` and `clampVault`. A stored `schemaVersion` therefore keeps whatever value it had.
- `mutate` checks every save with `deserializeVault(serializeVault(next))` (`service.ts:582`).

**Consequences:**
- If the version is not recomputed when a key entry is added, the vault serializes as v1 with a `kind` field, which §2.2 makes `invalid_vault`. The add then fails safely. That is a bug, not data loss.
- If the version is not recomputed after the last purge, the vault stays v2 and old clients stay paused.

**Fix:**
- `serializeVault` computes the version.
- `parseVault` returns it but nothing trusts it.
- Widen the type to `1 | 2`.
- Make "v2 with no live key entry" valid on read (it can come from an older v2 writer or a mid-purge snapshot) but never written.

**Blocks implementation:** no (Y5a).

### YR-26 (Low): the helper's exit cleanup listens for signals Chrome never sends

**Where:** §3.3 "退出时关上应用会话": "stdin 结束、收到 SIGTERM（Chrome 先发 SIGTERM，约 2 秒后 SIGKILL [推断]）或 Windows 控制台关闭事件时…先重新 SELECT".

**Fact [verified, N4]:** when the port is destroyed, Chrome closes the pipes, waits 2 s, then sends SIGKILL (POSIX/Mac) or `TerminateProcess` (Windows). No SIGTERM is sent, and `TerminateProcess` delivers no console event.

**Failing sequence:**
1. The popup closes, and the helper is blocked in a 3–30 s APDU (a touch wait).
2. It does not read stdin EOF until the APDU returns.
3. Two seconds later it is killed without re-SELECTing, so the applet stays VALIDATEd for other PC/SC clients (the A12 row).

**Fix:**
- A dedicated thread reads stdin. On EOF it immediately cancels the PC/SC operation (`SCardCancel`), re-SELECTs or disconnects with `SCARD_RESET_CARD`, and exits, all inside 2 s.
- Drop the SIGTERM and console-event text.
- Test: close the page during a touch wait, then check with a second PC/SC client that a CALCULATE needs VALIDATE.

**Blocks implementation:** no (Y4).

---

### YR-31 (Low): forcing a FIDO2 PIN creates a lockout path that wipes the user's website logins on that key

**Where:** §1.2.2 ("钥匙还没有 FIDO2 PIN 时，Chrome 会引导用户设置一个") and §1.2.7.

**Facts [verified]:**
- YubiKeys ship with no PIN.
- Eight wrong PINs lock the FIDO2 application, and three in a row require re-inserting the key (Yubico technical manual, FIDO2 section).
- The only way out of a lockout is a FIDO2 reset, which deletes every FIDO credential on the key.

**Failing sequence:**
1. A user who never needed a PIN sets one at Sixkey enrolment.
2. They forget it and lock the key.
3. Resetting the key removes every passkey and security-key login it held for websites. Sixkey loses nothing, because the password still works.

**Fix:** at enrolment, when Chrome is about to ask for a new PIN, show one line first: "You are about to set a PIN for this security key. Remember it: 8 wrong tries lock the key, and unlocking it deletes the website logins stored on it."

**Blocks implementation:** no.

### YR-29 (Info): the reason D16 gives for keeping WebAuthn out of the popup is partly wrong; the decision is still right

**Where:** D16, §5.6 and §7.3 G1 ("工具栏弹窗里调用确实会被关掉（证明小窗口是必要的）"). The source is ux-study C7.

**Facts [verified, Chromium commits]:**
- Commit 4b8e494ea3 (M156) force-closes the popup when *another* security dialog is present. It skips dialogs that descend from the popup: "Don't close if a web modal dialog (e.g. webauthn security key dialog) is showing".
- M127 blocks popups from opening while a security dialog is visible.
- M142 shows the popup's own WebAuthn modal as a desktop widget.

**Consequences:**
- On macOS and Linux, a WebAuthn call from the popup may keep the popup open, so G1's "prove the popup closes" check may fail.
- The window is still the right choice. On Windows the security-key UI is the operating system's dialog, which is not a Chrome widget, so the popup probably loses focus and closes [inferred]. The PIN entry, the ≤ 60 s timeout and the M156 behaviour for other dialogs all argue for a stable surface.

**Fix:** reword D16's reason, and change G1 to "measure, then use the window regardless".

**Failing sequence:** none. The decision is right and only its reason is wrong. The risk is that a G1 result of "the popup did not close" gets read as permission to move WebAuthn into the popup.

**Blocks implementation:** no.

---

## 2. Plausible concerns (need a probe, or depend on implementation)

### YR-28 (Medium): on Windows, webauthn.dll may ignore hmac-secret for non-discoverable credentials, and §1.2.2 step 3 would then reject every key

**Where:**
- D15 (`residentKey: "discouraged"`).
- §1.2.2 step 3: "`prf.enabled !== true` → '这把钥匙不支持'，什么也不保存".
- §1.2.6 and §7.3 G1. G1's fallback is only "use `sixkey.app`".

**Facts:**
- libfido2's `winhello.c` (2023-11) says: "webauthn.dll ignores requests to enable hmac-secret unless a discoverable credential is also requested". Corbado independently says Windows security keys "require hmac-secret & discoverable creds" [summary].
- PRF inputs at get() need webauthn.dll API v4 (`pHmacSecretSaltValues`). Below that, Chrome marks PRF as not evaluated: "This version of Windows does not yet support passing in inputs for hmac_secret" [verified, `webauthn.h`, `device/fido/win/webauthn_api.cc`].
- Windows 10 probably lacks v4 [unverified].

**Failing sequence:**
1. On Windows 11 with a YubiKey 5, create() runs with rk "discouraged".
2. webauthn.dll drops hmac-secret, so `prf.enabled` is false.
3. Sixkey says "这把钥匙不支持" for every key on Windows. The CTAP spec says authenticators SHOULD always create CredRandom, so a later get() might still have worked.

**Fix:**
- G1 tests rk discouraged against rk required on Windows.
- Gate on the verification get() returning `results.first`, not on `prf.enabled` alone.
- If Windows needs discoverable credentials, use `residentKey: "required"` there. That takes one of the key's resident slots. §1.2.4's "非常驻凭据在钥匙上没有可删的东西" then needs a removal step: Windows Settings › Passkeys, or `ykman fido credentials delete`.
- If v4 is missing (Windows 10), C is simply not offered.

**Blocks implementation:** yes, for Y3. It is a G1 scope addition.

### YR-4 (Medium): OATH authentication state is per card, but §3.3/§4.2 treat it as per helper process

**Where:**
- §3.3: `keys` returns `ch` from SELECT; `unlock` comes later; "连接在进程生命期内保持，所以验证状态通常保留".
- §4.2: "弹窗与设置页同时打开时，会有两个助手进程；PC/SC 的共享模式加短事务处理并发".
- §3.3: "退出时关上应用会话".

**Facts:**
- Every SELECT creates a fresh challenge. The authenticated flag lives in `CLEAR_ON_DESELECT` memory (ykneo-oath source). YubiKey 5 firmware is closed, so the same behaviour there is [inferred]. yubikit's NEO workaround after `set_key` is to re-select and unlock.
- By default, scdaemon takes the reader exclusively and is known to block ykman OATH. Its own man page calls `--pcsc-shared` "somewhat dangerous".
- Windows CertPropSvc "reads all certificates from all inserted smart cards" on insertion (a PIV SELECT).
- macOS's smart-card daemon connects in shared mode [summary].

**Failing sequences:**
- **(a) Two pages.** The popup is open with K in memory, and the settings › YubiKey panel opens.
  1. The settings helper's `keys` SELECTs.
  2. The popup's next `codes` gets `6982` and re-unlocks (SELECT + VALIDATE).
  3. That invalidates the settings session, which re-unlocks in turn. Both poll every 30 s, so the two ping-pong.
  4. A page without K prompts for the password again and again.
- **(b) A stray SELECT.** The user types the right password.
  1. Between `keys` (challenge c1) and `unlock`, something SELECTs: CertPropSvc on insertion, Yubico Authenticator, or the other Sixkey page.
  2. VALIDATE for c1 fails with `6A80`.
  3. The UI says "密码不对".
- **(c) Exit.** Closing the popup re-SELECTs as it exits, which ends the settings page's session.

**Fix (protocol):**
1. The helper SELECTs at the start of every transaction and never assumes the applet is still selected.
2. `unlock` is a single held `SCardBeginTransaction`: SELECT → send the challenge to the extension → wait for the response (≤ 2 s) → VALIDATE → the first command. Or make it two-phase: the helper reports a stale challenge with a fresh one, and returns `wrong_password` only for a VALIDATE that followed its own SELECT in the same transaction.
3. The page keeps K for its lifetime and re-validates silently.
4. Only one page drives the key at a time. For example, the settings panel suspends polling while a popup is open, coordinated over a `BroadcastChannel`. Or document the clash.
5. Map `SCARD_E_SHARING_VIOLATION` to "another program (for example gpg's scdaemon) is using the YubiKey".

Add to G2: two pages, Yubico Authenticator running, scdaemon running, and Windows insertion.

**Blocks implementation:** yes, for the protocol freeze.

### YR-10 (Low): the protocol must say that the period comes only from the credential name

**Where:** §3.3, "挑战 = floor(助手系统时间 / p) + step".

**Problem:** the `code` and `codes` parameters carry no period, which is correct, but nothing states the rule. If any request field could set `p` (a future option, a "custom period" fix), D5 collapses: `p = 1, step = 1` gives `floor(t/1) + 1`, which is the 30-second challenge for a time about 30·t in the future.

**Fix:** add this to §3.3:
- `p` is parsed by the helper only, from the name prefix. Parsing is strict: digits only, no leading zero, 1–86400.
- Request schemas contain no `p`, `t` or challenge. Unknown fields are already rejected.
- A unit test asserts the challenge for every name form.

**Blocks implementation:** yes, for the protocol freeze (one sentence and a test).

### YR-11 (Low): make the APDU allowlist structural and runtime-checked; fuzz the card side too

**Where:** §3.2 ("CI 里有一条测试枚举所有能构造 APDU 的代码路径") and §6.1.

**Problem:** a test cannot enumerate code paths.

**Facts [verified]:**
- RESET is `00 04 DE AD`.
- yubikit uses extended APDUs on YK4+ over USB, and CLA `0x10` command chaining for long data.
- YK 4.2.0–4.2.6 needs a dummy-APDU touch workaround.

**Fix:** the single transmit function asserts, before `SCardTransmit`:
- CLA `00`, no chaining, short APDUs only.
- (INS, P1, P2) is in the table.
- Exact data bounds:
  - SELECT: the AID bytes, exactly.
  - VALIDATE: `0x75` with the HMAC length of the SELECT's `0x7B` algorithm (20/32/64), plus `0x74` with 8 bytes.
  - CALCULATE: `0x71` up to 64 bytes, plus `0x74` with 8 bytes.
  - LIST and SEND REMAINING: no data.

Tests run through a recording mock transport. `cargo-fuzz` gets targets for the card-response parser (TLV, `61xx` chains, truncated codes, `0x7B`), not only the JSON framing (§6.1 fuzzes only the latter). State that YK 4.2.0–4.2.6 touch is unsupported.

**Blocks implementation:** no.

### YR-15 (Low): close the port promptly on lock or hide, and keep "every helper session starts with SELECT" as an invariant

**Where:** §1.2.9 "页面检测到锁定（epoch 变化）时…关闭原生端口" (no mechanism given) and §4.3.

**Problem:**
- Today Sixkey pages notice a lock lazily: "在下一次使用时失效" (`service.ts` `currentVk`).
- While a port stays open, the applet stays VALIDATEd for every PC/SC client (the A12 row). A settings tab left open after a screen lock keeps the key unlocked.
- A10, going through the genuine helper, cannot ride another process's session, because its own `keys` SELECTs first and so de-authenticates [inferred]. Keep that true on purpose.

**Fix:**
- The YubiKey module subscribes to `chrome.storage.session.onChanged` for `sk_lock_epoch` (the pattern already exists in `options/Backup.tsx:71–74`) and to `visibilitychange`, and disconnects on either.
- The helper re-SELECTs after N seconds without requests.
- §3.3 states: "every helper session starts with SELECT; no op assumes a prior VALIDATE from another process".

**Blocks implementation:** no.

### YR-17 (Low): A10 can time a touch request to coincide with a real WebAuthn touch

**Where:** N2 and §4.5 A11 ("需要触碰的凭据要真人触碰").

**Problem:** A10 controls the browser, so it sees when the user is about to touch the key for a website's security-key prompt. It can issue `code` for a touch credential at that moment. Whether one physical touch completes both a pending FIDO request and an OATH CALCULATE, or which one, is [unverified].

**Fix:** add the timing variant to A11/N2 and to SECURITY: "a touch does not tell you which program asked". Test the concurrent case on hardware in §6.3.

**Blocks implementation:** no.

### YR-18 (Low): any card that answers the OATH AID in any reader is treated as a YubiKey

**Where:** §3.2 "探测" (SELECT on every card in every reader, NFC included).

**Problem:** a programmable contactless card in an NFC reader's field can claim any salt, and so any `deviceId` hint, plus any names and codes. "从 YubiKey 添加" would then write names the attacker chose into the synced vault. Rows would show "from key ·· a1b2".

**Fix:**
- Show the reader name next to each key, and mark keys seen through NFC readers.
- Never prefer a key on the `deviceId` hint alone.
- Treat names as untrusted text (already the case).

**Blocks implementation:** no.

### YR-27 (Low): any file at the user-level manifest path hides the helper, and a remote CDP client may be able to put one there

**Where:**
- §3.7 fact 2 and the A12 row ("用户级清单 `allowed_origins` 不对时 Chrome 直接'禁止'、不回落，可造成拒绝服务").
- §3.13: `host_forbidden` is explained as "most often not from the store".

**Facts:**
- `FindManifestInDir` checks only that the path exists [verified, N8]. Any `app.sixkey.oath.json` in `<user-data-dir>/NativeMessagingHosts`, even an empty or invalid file, makes Chrome report not-found or forbidden and never look at the system-level host.
- CDP `Browser.setDownloadBehavior` / `Page.setDownloadBehavior` set an arbitrary download path [verified that the methods exist; the use here is inferred].

**Failing sequence:**
1. A10 on the LAN (the new exposure A11 names) points downloads at the user-level directory.
2. It downloads a file named `app.sixkey.oath.json`.
3. A is broken for that profile until the user finds the file. A downloaded file is not executable, so there is no code execution unless the manifest `path` names an existing binary [inferred].

**Fix:**
- Extend A12's DoS sentence to "any file at that path".
- In §3.13, give `host_missing` and `host_forbidden` on a store install a third cause: "a file in this browser's profile folder (`NativeMessagingHosts/app.sixkey.oath.json`) is hiding the helper; delete it".
- Point the help page's hardening section at `NativeMessagingUserLevelHosts=false` (now verified, N14).

**Blocks implementation:** no.

### YR-30 (Info): the WebAuthn RP is really the string `chrome-extension://<id>`, and the dialog will probably say "chrome-extension"

**Facts [verified, Chromium source]:**
- Blink fills an unset `rp.id` with the bare ID. Then `MaybeGetRelyingPartyIdOverride` rewrites it to `caller_origin.Serialize()` ("we use the whole origin to avoid collisions with the RP ID space for HTTPS origins").
- So the authenticator hashes `"chrome-extension://<id>"`. That has been true since Chrome 81 (commit 5f3963f128, "webauthn: allow use in extensions").
- Passing that full string as `rp.id` fails validation.
- Chrome's dialog builds its label with `RpIdToElidedHost(GURL("https://" + rp_id))`, so it probably shows "chrome-extension" [inferred]. What Windows shows is [unverified].
- A native process with the key, its PIN, a touch, the credential ID and the pre-hashed salt can derive the same PRF output through libfido2 (`fido_assert_set_rp`) or `WebAuthNAuthenticatorGetAssertion(…, pwszRpId, …)` [verified, API docs].

**Fix:**
- In §1.2.6, D14 and §4.5 A15, say "RP ID = the extension's origin string; never set `rp.id`".
- Note that RP-ID uniqueness is enforced by browsers, not by authenticators. Against a local process the protection is key + PIN + touch, which the design already requires; touch is mandatory for hmac-secret (CTAP 2.1: `up=false` → `CTAP2_ERR_UNSUPPORTED_OPTION`).
- The unlock window should tell the user that the browser will name the requester "chrome-extension".

**Failing sequence:**
1. The user sees a security-key prompt that names only "chrome-extension".
2. They cannot tell it is Sixkey's.
3. They learn to approve unexplained prompts.

There is no cryptographic consequence, because only Sixkey can assert this RP ID in the browser.

**Blocks implementation:** no.

### YR-21 (Info): zero tracking holds for Sixkey, but signing triggers operating-system checks, and the sandbox writes a directory

**Problems:**
- Installing or first-running a signed and notarized helper makes the OS contact the vendor: macOS Gatekeeper/notarization and certificate revocation checks, and Windows SmartScreen reputation [inferred, general platform behaviour]. These are not Sixkey requests.
- macOS App Sandbox creates `~/Library/Containers/<bundle id>` the first time a sandboxed tool runs. "不建目录" (§3.5) is therefore literally false, because the OS does it [inferred].

**Fix:**
- PRIVACY: "your operating system may check the helper's signature online when you install or first run it".
- §3.5: "the helper writes nothing; the OS may create its sandbox container".

**Failing sequence:** a user or reviewer watching network or file activity sees Apple or Microsoft contacted at install, or a new container directory, and concludes the zero-network or no-files promise is false.

**Blocks implementation:** no.

### YR-22 (Info): A14 is narrower than written

User-level hosts live in `<user-data-dir>/NativeMessagingHosts`, next to the profile directory `Default/`, not inside it. The vendor uploads documented in `fingerprint-browser-security-lessons.md` (GoLogin's SDK) zip `Default/`. A shadow also needs an executable at an absolute path on the receiving machine.

**Failing sequence:** only possible with a vendor that syncs the user-data-dir level and keeps file modes.

**Fix:** keep A14, marked [inferred], at lower likelihood. The FINGERPRINT-BROWSERS note (§5.3) should name the folder's real location: next to `Default/`, not inside it.

**Blocks implementation:** no.

### YR-23 (Info): the A estimate looks optimistic

L + M (5–7 weeks) has to cover all of this:
- Three signed installers: MSI for two architectures, a universal2 pkg with notarization, deb and rpm.
- Reproducible builds with signatures embedded.
- The macOS sandbox and seccomp unknowns (G2).
- Two fuzz targets.
- The §6.3 matrix: about 7 models × 3 operating systems × several browsers.
- The store-ID dependency.

**Failing sequence:** none (a planning risk). If Y5a is held for G2 and the store submission is held for Y5a (Q4), a slow G2 delays the store release.

**Fix:** plan G3 with slack. Decouple Q4: Y5a's parse/merge/validate can land before G2, because only the "add from YubiKey" mapping needs a real key.

**Blocks implementation:** no.

---

## 3. What I checked and found sound

- **The read-only allowlist (D4, §3.2) is justified.**
  - The spec says "authentication is required for all commands except VALIDATE and RESET". RESET is `00 04 DE AD` and needs no auth.
  - PUT, DELETE, SET CODE (an empty `0x73` removes the password) and RENAME (fw 5.3.0/5.3.1, missing from the spec page and documented in YESDK) are all correctly left out [verified].
  - INS `A4` is both SELECT and CALCULATE ALL. The design already keys the allowlist on (INS, P1, P2) [verified].
- **The helper-owned clock (D5) is the right control for in-browser callers.**
  - CALCULATE answers arbitrary challenges.
  - The TOTP challenge is `struct.pack(">q", t // period)`.
  - The period is a client convention in the name (`period/issuer:name`). The name is at most 64 bytes [verified].
- **The OATH-password split (D6) matches the protocol.**
  - The spec's SET CODE: "1000 rounds of PBKDF2 with the ID from select used as salt. 16 bytes of that are used". The spec does not name the PRF; SHA1 comes from yubikit (`pbkdf2_hmac("sha1", …)`) and yubikit-android.
  - VALIDATE sends `0x75` (the response) and `0x74` (our challenge), and gets `0x75` back.
  - There is no NFKC, which matches yubikit's `passphrase.encode()`.
  - There is probably no retry counter: none in the spec or the NEO applet. So the offline-guessing statement for a shadowing helper, and "use a long password", are right [verified/inferred as marked].
  - K never reaches the helper. The design honestly says this buys little against a shadowing helper.
- **`deviceId` is exactly ykman's.** It is `sha256(salt)[:16]` in standard base64 with `=` stripped, and RESET regenerates the salt [verified]. Using base64url is a harmless encoding difference.
- **CALCULATE ALL handling is right.** HOTP and touch credentials return names only, and non-30-second credentials are recomputed one by one (yubikit) [verified].
- **The licences are right.**
  - yubikey-manager: BSD-2.
  - yubioath-flutter: Apache-2.0.
  - ykneo-oath and yubioath-desktop-dpkg: GPL-3.0.
  - pyscard: LGPL-2.1-or-later.
  - Rust `pcsc` 2.9 and `pcsc-sys`: MIT only, as the design says.
  - The spec pages carry no licence, and Yubico's website terms grant no right to reproduce them. That makes the clean-room-from-facts plan and "do not copy the spec text" correct [verified].
- **Matching by credential name (D9) is right.** RESET regenerates the salt, so `deviceId` changes (Y7), and the official backup advice is "the same QR code on two keys". An entry restored or synced to a machine without the key shows "需要 YubiKey" and is never hidden or deleted (§1.1.3). The wrong-key-same-name case (§2.7) fails closed: a wrong code, nothing leaked.
- **Seeds cannot be read back from the key** [verified]. So the "never lose data" gap is structural, and §2.6's mitigations are the right ones: a mandatory acknowledgement, labels everywhere, and Sixkey never deleting anything on the key. YR-20 adds one.
- **Data model:**
  - The discriminated union replaces the overloaded empty secret.
  - A purge becomes the existing v1 tombstone (`isPurged` unchanged; the tombstone carries nothing).
  - `kind` and `ref` sit inside the content register, so there are no half entries.
  - `counter` keeps its max across kinds, which preserves associativity.
  - A version derived from merged content stays commutative, associative and idempotent.
  - v1 with `kind` is rejected.
  - Paths that already handle `newer_schema`: `validate.ts:77`, `store.ts:773/803/813` (they stop and do not fall back), `backup.ts:75`, `popup/load.ts:24` and `options/App.tsx:68` [verified in code].
  - `mergeVaults` unions entries by id, so a client that is paused or old can never delete key entries by not knowing them.
  - Excluding key entries from subset export keeps H-d's unlinkability, and excluding them from plain export is honest.
  - Extending the I8 guard to `ref.name` and to kind switches is right.
- **PRF wrap:**
  - A per-credential random salt, a new HKDF label, and an AAD binding `vaultId|vkId|credId`.
  - A VK change nulls the wrap; re-enabling takes one touch and a **new salt**, so earlier PRF outputs are useless afterwards.
  - The rejected indirect DK is argued correctly.
  - Keeping `sk_prf` outside the keyring is consistent with SYNC-DESIGN §2.3 (the sync keyring is exactly `{password, recovery}`, enforced in `keybundle.ts:56`) and with §0.0i item 12 (a byte-stable keyring; adoption writes `bundle.keyring` itself, so PRF wraps would be lost or would break "same keyring").
  - The `VkRecord` contract (`service.ts:73–97`) allows a record to decide what "re-encrypt" means.
  - `finishKeyChanges` runs records before the store.
- **PRF parameters (D15):**
  - `userVerification: "required"` is correct and necessary: the spec makes PRF use the UV output, and hmac-secret keeps separate with-UV and without-UV secrets (W2, W3). A found key without its PIN therefore gives the wrong KEK.
  - Touch is mandatory for hmac-secret (W3).
  - `evalByCredential` with `allowCredentials` (W4) and always doing a second get() at enrolment (W5) both match Chrome.
  - Extension-page WebAuthn needs no host permission and works on Chrome 120 (since 81, W1).
- **H1:** PRF is not in the keyring, so `removeMethod` can never leave PRF as the only method.
- **Sessions:** PRF unlock goes through the same `startSession` (`service.ts:267`), so `lockEpoch` voiding and always-lock behaviour carry over.
- **Sensitive operations:** export, password change, rotation, reset and `pw_auth` still need the password, because PRF cannot produce `pw_auth` (SYNC-DESIGN §3.14). Ordinary sync writes need only VK, so PRF-unlocked sessions still sync, and `needs_password` adoption still asks for the password.
- **WebAuthn placement:** WebAuthn only in a settings tab or a `chrome.windows.create` window, never in the popup. This matches ux-study C7 (M156 force-closes popups on security dialogs) and C15 (a permission request closes the popup).
- **Port placement:** the port lives in pages, never in the SW, and `sendNativeMessage` is not used. A port keeps the SW alive (N5), and the host dies with the port (N4).
- **Native-messaging facts behind D18 hold [verified, N6–N9, N15]:**
  - User-level is looked up first, in `DIR_USER_DATA`.
  - There is no fallback after the first manifest found.
  - Windows checks HKCU before HKLM and the 32-bit view first, and Chromium-branded builds really do fall back to the Google Chrome key.
  - `allowed_origins` rejects wildcard hosts.
  - The extension learns nothing about which binary ran.
- **Honesty about the host:** system-level install only, no pairing (a relay defeats it), and an honest "the extension cannot tell which binary ran".
- **check-dist:** the rules are feasible against the real `check-dist.mjs` (`OPTIONAL_ALLOWED` and `PERMISSIONS_ALLOWED` exist). `smoke.spec.ts` asserts `m.permissions` exactly, which an optional permission does not change. Add a matching `optional_permissions` assertion.
- **e2e fake-host plan:** it fits `harness.ts` (`launchPersistentContext(userDataDir)`, ID from the SW URL). ux-study appendix A already resolves the design's [未核实]: Playwright's bundle is Chrome for Testing (156.0.8078.4, cache `chromium-1248`).
- **B** is out of scope, and the reasons are sound.

### 3.1 PRF (C) attacker questions, answered explicitly

- **Profile copy + brief access to the key, without the PIN.** Nothing. The non-UV output comes from CredRandomWithoutUV, so the KEK is wrong (W3). PIN guessing is capped at 8 tries, with a re-insert after every 3 (W7).
- **Profile copy + brief access to the key + the PIN** (shoulder-surfed, or typed into the vendor's shared profile).
  1. With a native tool such as `fido2-assert` / libfido2 or `webauthn.dll`, the attacker needs five things: the RP ID string `chrome-extension://<id>`, the credential ID and salt from `sk_prf`, the PIN, and one touch (YR-30, W3).
  2. That gives the 32-byte PRF output once. It then decrypts the wrap offline, now and against every later copy, until the wrap changes.
  3. The wrap changes only on a VK change (re-enable uses a new salt). A password change does not change it.
  4. So this attack is exactly A16's "copy + key + PIN = unlock", and it persists like knowledge of VK: rotation ends it (YR-7, YR-8).
- **Vendor-synced or shared profile.**
  - `sk_prf` travels with `chrome.storage.local` (the `Local Extension Settings` folder that the vendors upload).
  - Anyone who opens that profile and holds the key and its PIN can unlock. Nobody without the physical key can, which is stronger than a password shared within a team.
  - P14 states the rest correctly.
- **Replay.** The WebAuthn challenge plays no part in the PRF output, so "replay" means reusing a captured PRF output. Capturing one needs code running in the unlock window while it runs, and at that moment the attacker could read VK directly. So replay never exceeds VK knowledge, and the fresh salt on re-enable ends it after rotation.
- **Downgrade or bypass of UV.**
  - It cannot be forced off, because a non-UV assertion gives the wrong key (W2, W3).
  - The 14-day rule is not a security control (YR-14).
  - Falling back to `sixkey.app` (G1's partial GO) would make other `<all_urls>` extensions able to assert. The design already names salt secrecy and `allowCredentials` as hard requirements for that branch.
- **A10 while locked.** It can open the unlock window and start a get(), but completing it needs a person's touch and PIN. A10 cannot fake those: the virtual authenticator does not hold this credential (P3 is correct). The touch-timing variant of YR-17 applies to WebAuthn too: a user who expects a prompt may approve it.

### 3.2 Wide-permission extensions and other in-browser attackers (attack 1)

- **Another store extension cannot use the helper.** `allowed_origins` holds only Sixkey's ID (N8, N9), and Sixkey declares no `externally_connectable` (check-dist enforces it).
- **Another extension cannot debug Sixkey's pages.** Its `chrome.debugger` cannot attach to them: `ExtensionMayAttachToURL` rejects a `chrome-extension://` URL whose host is not the caller's ID, unless a command-line switch is set (`AreExtensionsOnExtensionURLsAllowed()`; switch name not checked) [verified, https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/debugger/debugger_api.cc].
- **Content scripts** cannot run in other extensions' pages (ux-study C24).
- **No other extension or website can assert Sixkey's RP ID** (W1).
- **What remains is A10 proper.** A CDP client on the browser (not an extension), a browser started with that switch, and malware all reach Sixkey's pages directly. A11 and YR-1 cover them.

---

## 4. External fact checks

| # | Claim in the design | Result | Source |
|---|---|---|---|
| Y1 | YKOATH opcodes; SELECT `00 A4 04 00` + AID; CALCULATE/CALCULATE ALL P2 `01` = truncated; SEND REMAINING on `61xx` | Confirmed. RESET is `04 DE AD`; RENAME is not in the spec (YESDK fw 5.3.0; yubikit requires 5.3.1) | https://developers.yubico.com/OATH/YKOATH_Protocol.html ; https://docs.yubico.com/yesdk/users-manual/application-oath/oath-commands.html ; https://raw.githubusercontent.com/Yubico/yubikey-manager/main/yubikit/oath.py |
| Y2 | SELECT tags `79/71/74/7B`; challenge only when a password is set | Confirmed. Salt length is not in the spec (8 in the NEO applet) | spec; https://raw.githubusercontent.com/Yubico/ykneo-oath/master/applet/src/pkgYkneoOath/YkneoOath.java |
| Y3 | PBKDF2-HMAC-SHA1, 1000 rounds, salt = SELECT ID, 16 bytes | Partly. The spec gives rounds, salt and length, not the PRF; SHA1 comes from yubikit and yubikit-android | spec SET CODE; yubikit `_derive_key` |
| Y4 | VALIDATE `0x75`+`0x74` → `0x75`; auth state per SELECT | Format confirmed. Per-SELECT state is inferred from the NEO applet (`CLEAR_ON_DESELECT`). Wrong key → `6A80` | spec; NEO source; https://raw.githubusercontent.com/Yubico/yubioath-flutter/main/helper/helper/oath.py |
| Y5 | Touch timeout | **Wrong in §3.3's mapping**: `6982` (shared with "auth required"), not a distinct code; the timeout length is undocumented | ykman `_cli/oath.py`; yubioath-flutter `_do_with_touch` |
| Y6 | HOTP and touch in CALCULATE ALL | HOTP is always `0x77`, so touch is unknowable for HOTP | yubikit `calculate_all`; ykman CLI comment |
| Y7 | `_get_device_id`; salt regenerated on reset | Confirmed (standard base64, `=` stripped) | yubikit `oath.py` |
| Y8 | Licences | Confirmed; `pcsc` is MIT only; pyscard is LGPL-2.1+ | GitHub API / crates.io / pyscard source header |
| Y9 | Seeds cannot be read | Confirmed | spec; https://docs.yubico.com/yesdk/users-manual/application-oath/oath-overview.html |
| Y10 | Other components select other applets | CertPropSvc reads all certificates on insertion; scdaemon is exclusive by default | https://learn.microsoft.com/en-us/windows/security/identity-protection/smart-cards/smart-card-certificate-propagation-service ; https://www.gnupg.org/documentation/manuals/gnupg/Scdaemon-Options.html |

| # | Claim in the design | Result | Source |
|---|---|---|---|
| N1 | `nativeMessaging` can be optional (§4.1) | Confirmed: not in the cannot-be-optional list, and no `kFlagCannotBeOptional` flag in `extensions_api_permissions.cc`. The permission is re-checked at connect time. Minimum Chrome version undocumented | https://developer.chrome.com/docs/extensions/reference/api/permissions ; `extensions/common/permissions/extensions_api_permissions.cc` |
| N2 | Re-request after remove is silent (§4.1) | **Confirmed, and permanent**: `RemoveType::kSoft`; `kHard` is test-only (YR-1) | `extensions/browser/api/permissions/permissions_api.cc` ; `extensions/browser/permissions/permissions_updater.h` |
| N3 | A user gesture is required | Confirmed. CDP `Runtime.evaluate` `userGesture` satisfies it in extension pages [inferred from code; verified that the parameter exists] | https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate |
| N4 | The host lives until the port is destroyed; `~NativeMessageProcessHost` → `EnsureProcessTerminated` (§1.1.6) | Confirmed ("keeps it running until the port is destroyed"). **§3.3 is wrong that "Chrome 先发 SIGTERM"**: no signal is sent. The pipes close (EOF on stdin), then after 2 s comes SIGKILL (POSIX/Mac) or `TerminateProcess` (Windows). The re-SELECT cleanup must therefore run on stdin EOF within 2 s; Windows gives no console-close event | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging ; `native_message_process_host.cc` ; `base/process/kill*.cc` |
| N5 | A port keeps the SW alive since Chrome 105 (D3) | Confirmed | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle |
| N6 | User-level is checked first, then system-level; user-level = `DIR_USER_DATA/NativeMessagingHosts`, which follows `--user-data-dir` | Confirmed. Chrome creates that directory at startup | `chrome/browser/extensions/api/messaging/launch_context_posix.cc` ; `chrome/common/chrome_paths.cc` ; `chrome_main_delegate.cc` |
| N7 | Windows: HKCU before HKLM; 32-bit view first; Chromium branding tries `SOFTWARE\Chromium` and then falls back to `SOFTWARE\Google\Chrome` | Confirmed, including the fallback (Chrome for Testing also has `CHROMIUM_BRANDING`). Edge: Edge → Chromium → Chrome keys, HKCU then HKLM | `launch_context_win.cc` ; https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging |
| N8 | First-found user-level manifest with wrong `allowed_origins` → forbidden, no fallback | Confirmed, and broader: `FindManifestInDir` checks only that the path exists, so **any** file named `app.sixkey.oath.json` in the user directory (even an invalid one) gives NOT_FOUND or FORBIDDEN with no fallback. Only the `NativeMessagingUserLevelHosts=false` policy prevents this | `launch_context.cc` |
| N9 | `allowed_origins` rejects wildcards; `stdio` only | Confirmed for host wildcards and match-all. A path wildcard (`chrome-extension://ID/*`) is not rejected, which is harmless | `native_messaging_host_manifest.cc` |
| N10 | Origin is the first argument; Windows adds `--parent-window`; 1 MB host→Chrome, 64 MiB Chrome→host | Confirmed. More arguments may follow (`--reconnect-command=` when native-initiated connections are on), so the helper's check must read only argv[1] | `launch_context.cc` ; `native_message_process_host.cc` (`kMaximumNativeMessageSize`) |
| N11 | CSP `connect-src 'none'` does not affect `connectNative` (§4.4) | Undocumented. The code path (`OpenChannelToNativeAppImpl`) checks the permission, policy and manifest, with no CSP check [inferred]. Keep it in G2 | — |
| N12 | Chrome for Testing has separate system directories from 146 | Confirmed (docs and `GOOGLE_CHROME_FOR_TESTING_BRANDING`) | native-messaging doc |
| N13 | Flatpak/Snap unsupported | Confirmed: Chromium has no native-messaging proxy or portal client (Firefox has one). Snap strict confinement blocks host launches. This includes Ubuntu's default Chromium, which is a snap; Google Chrome's `.deb` is fine | Chromium source search; LP #1741074; `flatpak/xdg-native-messaging-proxy` |
| N14 | `NativeMessagingUserLevelHosts` (§3.8, marked [未核实]) | **Verified**: "Setting the policy to Disabled means Chrome can only use these hosts if installed at the system level"; it skips both the user directory and HKCU | `components/policy/resources/templates/policy_definitions/NativeMessaging/` |
| N15 | The extension cannot learn which binary ran | Confirmed: no UI and no path reach the extension; only the five error strings do | `launch_context*.cc` |
| N16 | `chrome.windows.create` needs no permission | Confirmed (`_api_features.json`: depends on `api:tabs`; the `tabs` permission gates only url/title) | `chrome/common/extensions/api/_api_features.json` |

| # | Claim in the design | Result | Source |
|---|---|---|---|
| W1 | Extension pages can use WebAuthn with their own RP ID when `rp.id` is unset; other extensions cannot claim it (§1.2.6, D14) | Confirmed, but the RP ID is the full origin `chrome-extension://<id>` (since Chrome 81; YR-30). The W1 quote is a paraphrase. The actual text: "Extensions will not be allowed to claim an RP ID that is unique to another extension, even if they have host permissions over them" (Chrome M122) | https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/webauthn/chrome_web_authentication_delegate.cc ; https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html |
| W2 | PRF must use the UV output and may override `userVerification` (§1.2.7) | Confirmed: "that PRF MUST be the one used for when user verification is performed. This overrides the UserVerificationRequirement if necessary." Salt = SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input) | https://w3c.github.io/webauthn/#prf-extension |
| W3 | hmac-secret gives different outputs with and without UV | Confirmed: CredRandomWithUV / CredRandomWithoutUV. **Touch is mandatory** (`up=false` → `CTAP2_ERR_UNSUPPORTED_OPTION`). A Bio fingerprint and its PIN fallback give the same output | https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-errata-20220621.html |
| W4 | `evalByCredential` with non-resident credentials | Confirmed. It needs a non-empty `allowCredentials`, and each key must match an entry | Blink `authentication_credentials_container.cc` ; `device/fido/get_assertion_task.cc` |
| W5 | PRF in Chrome 116; two ceremonies at enrolment (§1.2.2 step 4) | Confirmed (commit 9b8e20e8c5). Results at create need Chrome 146+ with an hmac-secret-mc key, or 147 on Windows with webauthn.dll v8. The design's "always do a get()" is right | chromiumdash |
| W6 | Windows + YubiKey PRF (§1.2.8) | Partly: needs webauthn.dll API v4 for salts at get(). **Non-discoverable credentials may not get hmac-secret** (YR-28). Windows 10 is [unverified] | https://github.com/microsoft/webauthn/blob/master/webauthn.h ; `device/fido/win/webauthn_api.cc` ; libfido2 `winhello.c` |
| W7 | YubiKey firmware: hmac-secret 5.2–5.8, mc only on 5.8; no PIN at the factory; 8 tries | Confirmed (technical manual). **Security Key NFC (blue) and Bio FIDO Edition list hmac-secret in FIDO MDS3**, which resolves §1.2.8's [未核实]. MDS also lists it for some pre-5.2 AAGUIDs, so keep detection at runtime | https://docs.yubico.com/hardware/yubikey/yk-tech-manual/yk5-apps-fido.html ; https://mds3.fidoalliance.org/ |
| W8 | CDP virtual authenticator `hasPrf`, `hasHmacSecret` (§6.2) | Confirmed in the PDL, but **`hasHmacSecret`/`hasHmacSecretMc` arrived only in Chrome 148** (commit 012c80d36f). Playwright's Chrome for Testing 156 has them. `hasPrf` emulates the CTAP "prf" extension, so the e2e tests cannot cover the UV/no-UV split | https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/WebAuthn.pdl |
| W9 | Popup force-close in M156 (D16) | Partly: dialogs from the popup itself are excluded (YR-29) | Chromium commits 4b8e494ea3, 321371e933, 18fc110c2d |
| W10 | Linux FIDO access | Confirmed: systemd `60-fido-id.rules` + `70-uaccess.rules` tag security tokens for the seat user. Minimal systems need a rule | `hid_service_linux.cc` ; libfido2 README |

**Source links for the file names above.** Chromium `main`, fetched 2026-10-16. Prefix `https://raw.githubusercontent.com/chromium/chromium/main/`:

| Topic | Paths under the prefix |
|---|---|
| Native-messaging launch | `chrome/browser/extensions/api/messaging/launch_context.cc` · `…/launch_context_posix.cc` · `…/launch_context_win.cc` · `…/native_message_process_host.cc` · `…/native_messaging_host_manifest.cc` |
| Paths and process | `chrome/common/chrome_paths.cc` · `chrome/app/chrome_main_delegate.cc` · `base/process/kill.cc` |
| Permissions | `extensions/browser/api/permissions/permissions_api.cc` · `extensions/browser/permissions/permissions_updater.h` · `extensions/common/permissions/extensions_api_permissions.cc` · `chrome/common/extensions/api/_api_features.json` |
| Policy | `components/policy/resources/templates/policy_definitions/NativeMessaging/` |
| Debugger | `chrome/browser/extensions/api/debugger/debugger_api.cc` |
| WebAuthn | `chrome/browser/webauthn/chrome_web_authentication_delegate.cc` · `third_party/blink/renderer/modules/credentialmanagement/authentication_credentials_container.cc` · `device/fido/get_assertion_task.cc` · `device/fido/win/webauthn_api.cc` · `chrome/browser/ui/webauthn/webauthn_ui_helpers.cc` · `content/browser/devtools/protocol/webauthn_handler.cc` |
| HID | `services/device/hid/hid_service_linux.cc` |

Commits are at `https://github.com/chromium/chromium/commit/<hash>`: 5f3963f128, 9b8e20e8c5, 9ad03026d4, 012c80d36f, 4b8e494ea3, 321371e933, 18fc110c2d.

Other sources:
- libfido2: https://github.com/Yubico/libfido2/blob/main/src/winhello.c and https://github.com/Yubico/libfido2#readme
- CDP: https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json and the `WebAuthn.pdl` link above.
- ykman CLI: https://raw.githubusercontent.com/Yubico/yubikey-manager/main/ykman/_cli/oath.py
- Rust `pcsc`: https://crates.io/crates/pcsc
- pyscard: https://github.com/LudovicRousseau/pyscard

---

## 5. Consistency notes (inside the document)

- **§0 item 1 and §4.6 against reality.** "Nobody / only the current code" is contradicted by HOTP and by direct PC/SC (YR-2, YR-9).
- **D20, §5.4 and §4.6 against §4.1 and N6.** The preset is used as a gate, while removal is admitted not to be one (YR-1).
- **§3.11 against §3.9 and §3.4.** A static musl build sits beside a `libpcsclite1` dependency and an import-table check (YR-12).
- **§3.3 against the facts.** `6982` is mapped as "locked only" (YR-3).
- **§1.1.3 "YubiKey 5 · 固件 5.7.1".** The OATH SELECT gives only the applet version. The model name would need the management application, which the allowlist excludes. Show "YubiKey · 5.7.1".
- **§2.1 `ref.touch`.** For HOTP it is always unknown (Y6). Store it only for TOTP.
- **§3.5 "不建目录" against the macOS sandbox** (YR-21).
- **A17 "no worse than the password"** (YR-7).
- **Wrong statements about Chrome:**
  - §3.3 "Chrome 先发 SIGTERM" (marked [推断]) is wrong (N4, YR-26).
  - §6.2 "Chrome for Testing 只读后者" is wrong: Chrome for Testing has Chromium branding and reads `SOFTWARE\Chromium` first (N7). It is harmless for the e2e setup.
- **Facts the design can upgrade:**
  - §3.8's `NativeMessagingUserLevelHosts` can move from [未核实] to verified (N14).
  - §4.1's "permission back without prompting" is not just "usually": it is the kSoft implementation (N2).
- **§3.3's argv check.** Chrome may append more arguments (N10). Check argv[1] only.
- **WebAuthn statements:**
  - §1.2.8's "Security Key 系列 hmac-secret [未核实]" is resolved: FIDO MDS3 lists it (W7).
  - §6.2's virtual-authenticator options need Chrome 148+ for `hasHmacSecret` (W8).
  - D16's reason (YR-29).
  - "RP ID = extension ID" is really the origin string (YR-30).
  - §1.2.4's "非常驻凭据在钥匙上没有可删的东西" may not hold on Windows (YR-28).
- **Effort** (YR-23).

---

## 6. Counts and top 3

| Severity | Confirmed | Plausible | Total |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 1 (YR-1) | 0 | 1 |
| Medium | 4 (YR-2, YR-3, YR-5, YR-6) | 2 (YR-4, YR-28) | 6 |
| Low | 12 (YR-7, 8, 9, 12, 13, 14, 16, 19, 20, 25, 26, 31) | 6 (YR-10, 11, 15, 17, 18, 27) | 18 |
| Info | 2 (YR-24, YR-29) | 4 (YR-21, 22, 23, 30) | 6 |

**Blocks implementation:**
- YR-3, YR-4 and YR-10 block the A protocol freeze (Y4/Y5b).
- YR-6 and YR-28 block Y3 (G1 scope).
- YR-1 blocks G4 (release text), not code.
- Everything else is fixed in the stage it belongs to.

**Top 3:**
1. **YR-1.** The shared/automated preset is presented as switching A off. An A10 process re-grants `nativeMessaging` silently and reads YubiKey codes in exactly the profiles the preset is for.
2. **YR-4 + YR-3.** The helper protocol's OATH session and error model (state per card, a non-atomic SELECT→VALIDATE, `6982` meaning both touch timeout and locked) will make password-protected and touch credentials fail in ordinary use. Fix both before the protocol freezes.
3. **YR-2.** HOTP turns "current codes only" into "codes usable later" for any A10. Decide Q5 with that in the text, or ship v1 without HOTP.

---

## 7. What M2 must reserve now (R1–R8 confirmed or corrected)

| # | Verdict | Correction or addition |
|---|---|---|
| R1 | **Confirm** | Already true in code (`store.ts:773`, `:803`, `:813`); add the fault test. Apply the same rule to M2's previous-VK fallback (it is the same loop, §0.0i item 8) |
| R2 | **Confirm, stated more strongly** | Rather than only a grep for the literal, the rule is: M2 builds `Vault` objects only through `emptyVault` / `parseVault` / `mergeVaults` / the ops in `ops.ts`, never by object literal or by spreading a vault into a new `schemaVersion`. Keep the grep as the test. See YR-25 for why a hand-written v1 would break the round-trip check once key entries exist |
| R3 | **Confirm, with named sites** | §4.4 guard `secretChanged`; A4R-12's cross-vault purge (§0.0i item 13); §3.5's join "added" mode dedupe; §4.6 "find accounts". All go through `entryIdentity(e)` / `isPurged(e)`. Note that the same need already exists outside M2 in `service.ts:834` (`importBackup`), YR-13 |
| R4 | **Already satisfied; keep the test** | `keybundle.ts:56` rejects any wraps other than exactly password + recovery. Optional, not M2-blocking: drop `webauthn-prf` from local `METHODS` (YR-24) |
| R5 | **Confirm** | Also: `sk_prf` and `sk_oath` are not "vault data" for `hasAnyData`, and "turn off sync / remove sync identity" (D11) does not touch them (the naming outside `sk_sync_*` gives this). Reuse the A4R-4 interleaving harness |
| R6 | **Confirm, extend** | Also in M3's F6a walk-back (SYNC-DESIGN §4.3): a `newer_schema` version stops the walk with `paused_newer`. The engine never skips it to merge an older v1 version and upload over the head |
| R7 | **Confirm** | — |
| R8 | **Confirm** | C7 (security-log UI) is in progress now. A reader of v1 treats a v2 log as "newer" and stops appending (`security-log.ts:147`), so do one bump: M2's kinds + `prf_enrolled`, `prf_removed`, `prf_failed`, `oath_on`, `oath_off` together |
| New, doc only | Add | SYNC-DESIGN §3.13 / I11 still says "`Vault.schemaVersion` 仍为 1". The sync-doc owner should amend it now to "derived from content (YUBIKEY-DESIGN §2.2); new fields still bump it", so M2 code is not written around a stored constant |

Nothing for C belongs in KeyBundle, the envelope, the server or the contract vectors: confirmed.
