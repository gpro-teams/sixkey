# Protected accounts, recovery-key shares and inheritance: design proposal (ADVANCED-RECOVERY-AND-TIERS)

> **Status (2026-10-23): Feature B, recovery-key shares (§3), is implemented** at the owner's request
> (OWNER-DECISIONS/15), named "Recovery key shares" / 恢复密钥分片 (OWNER-DECISIONS/16 question C, 2026-10-23; the
> earlier name was "Recovery code shares" / 恢复码分片):
> `docs/design/notes/SHAMIR-NOTES.md` has what was built, how it was checked and where it departs from §3 (among others:
> a CRC-20 instead of SHA-256 check bits; no `contract/py` port or `shares` vectors yet).
>
> **Features A (protected accounts) and C (inheritance): a proposal, not approved and not implemented.** Nothing in
> `extension/`, `api/` or `contract/` changes because of those parts of this document, and `docs/SYNC-DESIGN.md` stays as it is until the owner approves a revision. §5.3 lists exactly what
> that revision would change. Two pieces of work were in progress while this was written, enrolment v2 (the pairing code)
> and the password-setup UX; nothing here depends on either. This proposal builds on `RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md`
> (the recovery study), `QUICK-UNLOCK.md` and `PQ-READINESS.md`, and does not repeat them. It has not been reviewed
> independently.

Date: 2026-10-20. Author: design proposal (Opus 5.5) at the owner's request.

**Markers**, as in the recovery study:

- **[verified]**: I read the primary source. That means this repository's code or docs, an official specification or vendor
  document, or vendor source code.
- **[transcribed]**: taken from a secondary write-up, or from a vendor page I fetched but did not test. Vendor claims stay
  vendor claims.
- **[inferred]**: my own reasoning.
- **[estimate]**: a number nobody measured.
- **[unverified]**: a claim I could not check.

Every [unverified] claim is collected in §7.

---

## 0. Summary and recommendation (read this first)

### 0.1 What the owner asked (translated)

1. **Shamir recovery.** Split the recovery key into 3 shares, any 2 of which recover it. Crypto wallets do this as
   standard; the owner found only hackathon projects among authenticators.
2. **Account inheritance.** After long inactivity, a designated heir can recover the accounts using shares.
3. **Tiered vault.** Everyday accounts open instantly with the PIN. High-value accounts (exchange, bank, domain) show their
   codes only after the master secret or a hardware key.

### 0.2 Short answers

| Question | Answer |
|---|---|
| **Tiers: worth it?** | **Yes, and it is the most valuable of the three.** Today the PIN session, the Touch ID gate and every unlocked page hold the vault key (VK), which opens every secret. With tiers, the secrets of "protected" accounts are encrypted a second time under a **high-value key (HVK)** that only the master password, the recovery key or a PRF security key/passkey can unwrap. **The PIN session never holds the HVK.** A stolen PIN, a coworker at an unlocked computer, or a program reading the session storage then sees everyday codes only. It does **not** help against offline cracking of the password or against phishing of the password (§2.2). |
| **Tiers: sync impact?** | **Yes, and it must be decided before sync ships.** The keyring's password and recovery wraps carry VK ‖ HVK (80 bytes, plus `hvkId`), so `api/openapi.yaml` (`PasswordWrap`, `RecoveryWrap`), the server's shape checks and the vectors change (§2.9). Adding it later would need both the password **and** the recovery key on every synced vault, because the recovery wrap cannot be rewritten without the recovery key. |
| **Shamir: the same recovery key or a new key?** | **The same 128-bit recovery key R**, split 2-of-3 (or 3-of-5). Shares are only another way to obtain R. Nothing in the keyring, the server or the contract changes. Changing the recovery key is the revocation: it makes every old share useless (§3.1). |
| **Shamir: SLIP-39?** | **SLIP-39's sharing arithmetic and its digest check, but not its word mnemonics.** Shares are written in the same Crockford base32 as the recovery key (36 characters, 9 groups of 4) with a domain-separated checksum. SLIP-39 words would make a Sixkey share look like a wallet backup, which the recovery study's §1.7 rules out for the same reasons it rules out BIP39 (§3.4). No dependency, no WASM: about 200 lines of TypeScript on WebCrypto [estimate]. |
| **Inheritance: possible locally?** | **Only as a manual kit.** The owner gives the heir one share and puts a second where the heir can get it after death (a will, a lawyer, a safe-deposit box). Detecting "inactivity" needs a server (§4.2). |
| **Inheritance: in the cloud?** | **Feasible with zero knowledge, as a heir-initiated request with a waiting period**, the model Bitwarden and others use, rather than a dead-man's switch with check-ins. The server holds one share, encrypted under a key derived from the heir's paper share. It releases that share if the owner does not reject the request within the waiting period (default 30 days). The server alone learns nothing; the server plus a stolen heir kit can open the vault; the waiting period is a server promise, not cryptography (§4.3–§4.5). It needs legal review and is a paid-cloud feature. |
| **Local or cloud?** | **Protected accounts, Shamir shares and the manual inheritance kit are local features, free, and never gated.** Only the cloud inheritance release needs the server. |

### 0.3 Recommendation and order

| Order | Feature | Effort [estimate] | Why this place |
|---|---|---|---|
| 1 | **Protected accounts** (tiers), including the keyring format change | 3–4 weeks + review | Best value. It changes the synced key format, so it must land before sync ships. |
| 2 | **Recovery-key shares** (Shamir), with the test-restore flow | 1.5–2 weeks | Small and standard. No protocol impact, so it can ship any time. It shares the "enter or replace the recovery key" step with item 1. |
| 2b | **Manual inheritance kit** | 3–5 days on top of item 2 | A printed letter plus one share; no server. |
| 3 | **Cloud inheritance release** | 4–6 weeks + legal review + security review | After sync has launched. It is additive (new endpoints only) and needs owner and legal decisions (§6). |

This agrees with the maintainers' guess. One refinement: build the "enter your recovery key, or make a new one" step
once, because protected accounts (upgrading an older keyring), Shamir (splitting R) and the inheritance kit all need R in
hand, and Sixkey never stores it (SYNC-DESIGN I9).

### 0.4 What must be decided before sync ships

1. **Keyring v2 for protected accounts** (§2.3, §2.9): the wraps carry VK ‖ HVK and `hvkId`. Changes: SYNC-DESIGN §2.1,
   §2.2, §2.3, §3.1 step 4, §3.9, §3.13; `api/openapi.yaml` `PasswordWrap` and `RecoveryWrap`; the server's keyring shape
   check; the `keybundle` and `labels` vector groups and a new `hvk` group; the Python reference.
2. **The vault reader for schemaVersion 3** (§2.4) in the first sync release, even if the "Protect" button comes later. The
   server never sees it (it is inside the envelope), and older clients already pause safely on a newer schema, but every
   client that ships with sync should read it so that one user's first protected account does not pause their other
   devices.
3. If the owner approves the recovery study's **account key** (two-secret derivation, its owner question 2), do it in the
   same format revision, because it also changes the wraps.

Shamir and inheritance need nothing before sync ships.

### 0.5 Owner questions

Listed with recommendations in §6:

1. Cloud inheritance: build it after sync launches, behind an external legal review, or ship only the manual kit?
2. Scope and money: cloud inheritance as part of the paid cloud, and how long a lapsed paid account with an heir
   arrangement is kept.
3. Naming of the three features in English and Chinese.

---

## 1. Facts that decide the design

### 1.1 Today's keys and sessions [verified, this repository]

- `core/crypto/keyring.ts`: the keyring wraps the 32-byte VK under a password KEK (PBKDF2-SHA256 ≥ 600 000 iterations,
  `deriveKey` straight to AES-GCM) and under a recovery KEK (HKDF of the 128-bit recovery secret). The wrap AAD is
  `sixkey-wrap|1|{method}|{vkId}|{vaultId}|{kdf}`. Methods: `device` (Phase 0), `password`, `recovery`, `webauthn-prf`
  (unused, deleted by YUBIKEY YR-24).
- `platform/session.ts`: `sk_session` in `chrome.storage.session` holds the VK while unlocked; `sk_quick` holds the PIN
  session's parked VK (QUICK-UNLOCK §5.2); every lock bumps `sk_lock_epoch`, and pages drop keys and codes when it changes.
- QUICK-UNLOCK §5.2: the PIN session wraps the **VK** under a PBKDF2 key from the PIN, in `storage.session`; the Touch ID /
  Windows Hello **gate** keeps the VK in `storage.session` as is ("Not protected: the gate is the UI").
- `core/vault/model.ts` and `merge.ts`: an entry has a content register (`type, issuer, label, secret, algorithm, digits,
  period, domains`, stamped by `hlc`), a placement register (`phlc`), a deletion register (`dhlc`) and a HOTP counter
  merged by maximum. `ops.ts` can edit the secret (`ContentPatch` includes `secret`).
- SYNC-DESIGN §3.13 / I11: any new entry field must raise `schemaVersion`, which is derived from content (1 normally,
  2 with YubiKey reference entries); an older client meeting a newer schema stops (`newer_schema`, `paused_newer`) and
  never merges the unknown fields away.
- SYNC-DESIGN §2.3: a KeyBundle with members the client does not know is kept and verified, but the client refuses key
  operations on it. The server checks that the wraps are exactly `{password, recovery}`, and that the recovery wrap changes
  exactly when a new `recovery_verifier` is sent, the password wrap exactly when `auth.kdf` and the `password_verifier`
  change (P4).
- `api/openapi.yaml`: `PasswordWrap.wrapped` and `RecoveryWrap.wrapped` are `B64Bytes48` (a 32-byte VK plus the 16-byte
  tag).
- SYNC-DESIGN §3.1 step 4: turning on sync requires the recovery key, either typed and verified or newly generated. So
  both secrets are in hand before the first upload.
- `core/backup/backup.ts`: the encrypted backup file has its own password and "never carries key material that opens
  anything else"; its plaintext is a serialised vault.
- `docs/security/local-vault.md`: the store keeps rolling snapshots of the last 10 changes, daily snapshots for 7 days and
  a mirror with up to 7 daily snapshots.
- `core/crypto/recovery-code.ts`: 128 random bits plus 12 check bits (SHA-256 of the secret, no tag) in 28 Crockford
  base32 characters, 7 groups of 4; the parser accepts any case, spaces and `-`, and reads O as 0 and I/L as 1. Since
  SYNC-DESIGN revision 27 the pairing code uses the same layout with a tagged check (`sixkey-pairing-code|1|`).

### 1.2 Shamir sharing and SLIP-39

**SLIP-39** ("Shamir's Secret-Sharing for Mnemonic Codes", SatoshiLabs). The specification is in the `satoshilabs/slips`
repository, whose licence is CC-BY-SA-4.0 [verified: the repository's licence field]. The reference implementation is
`trezor/python-shamir-mnemonic`, MIT, version 0.3.0 on PyPI [verified: `LICENSE`, PyPI metadata].

- **Field.** GF(256) with the Rijndael polynomial `x⁸ + x⁴ + x³ + x + 1`, bytewise Lagrange interpolation [verified:
  the specification and the reference `shamir.py`, `_precompute_exp_log`, `_interpolate`].
- **Split.** `0 < T ≤ N ≤ 16`; the secret is at least 128 bits and a multiple of 16 bits. With T = 1 every share is the
  secret. Otherwise: T − 2 random shares at x = 0 … T − 3; a **digest share** at x = 254, equal to
  `HMAC-SHA256(key = r, msg = S)[0..4] ‖ r` with r random of n − 4 bytes; the secret S at x = 255; the remaining shares at
  x = T − 2 … N − 1 by interpolation [verified: the specification; `_split_secret`, `DIGEST_INDEX = 254`,
  `SECRET_INDEX = 255`, `DIGEST_LENGTH_BYTES = 4`, `MAX_SHARE_COUNT = 16`].
- **Recovery.** Interpolate at 255 and 254; the first 4 bytes of the second must equal the HMAC of the first under the
  rest [verified: `_recover_secret`].
- **The specification's own caveats** [verified]:
  - the digest lets someone holding T − 1 shares test candidate secrets, which "reduce[s] the entropy from m to m − 32
    bits"; this is why the secret must be at least 128 bits;
  - SatoshiLabs knows of no proof that Shamir's scheme stays secure when partial information about the shares leaks, which
    is one reason the master secret is first encrypted with a strong pseudo-random permutation.
- **Encryption layer.** A 4-round Feistel network whose round function is PBKDF2-HMAC-SHA256, 10 000 × 2^e iterations in
  total, keyed by an optional passphrase. The passphrase is not verified: any passphrase yields some secret [verified].
- **Mnemonic.** A 128-bit secret gives a 20-word share: 200 bits = a 40-bit header, the 130-bit padded value and a 30-bit
  RS1024 checksum. The checksum "guarantees detection of any error affecting at most 3 words", and misses more errors with a
  chance below 1 in 10⁹ [verified].
- **Groups.** Up to 16 groups of up to 16 members; a member threshold of 1 with more than one member is forbidden
  [verified].
- **Test vectors.** `vectors.json` in the reference repository (MIT): description, mnemonics, master secret, BIP32 key; all
  valid sets use the passphrase "TREZOR" [verified: README]. They exercise the whole mnemonic path (words, RS1024, the
  Feistel layer), most of which Sixkey does not use; §3.3 says how Sixkey's arithmetic is cross-checked instead.
- **The reference is not for production.** Its README: "This implementation is not using any hardening techniques …
  calculations are most likely trivially vulnerable to side-channel attacks. The purpose of this code is to verify
  correctness of other implementations. It should not be used for handling sensitive secrets." It uses log/exp tables
  indexed by secret bytes [verified].
- **Adoption.** Trezor now calls it "Multi-share Backup"; Electrum, Sparrow, Keystone and OneKey, among others, support it
  [transcribed, vendor page].

**JavaScript libraries.** None is adopted (§3.3 explains why); they inform the implementation rules.

| Library | Licence | Release, audit | Notes |
|---|---|---|---|
| `shamir-secret-sharing` (Privy) | Apache-2.0 | 0.0.4, 2025-01-10 [verified: npm]. Audited by Cure53 (February 2023) and Zellic (July 2023) [transcribed: README and search summaries; the reports were not read] | GF(2⁸), modelled on HashiCorp Vault's layout. The README says it "is not responsible for verifying the result of share reconstruction", and that true constant time is "unrealistic" in JavaScript, so it aims for "algorithmic constant-time" [verified: README] |
| `slip39` (ilap/slip39-js) | MIT | 0.1.9, 2024-06-01 [verified: npm]; tested against the reference vectors; no audit found [unverified] | full SLIP-39, including words |
| `secrets.js-grempe` | MIT | 2.0.0, 2019-09-08, no release since [verified: npm]; no audit found [unverified] | its own share format |

Cure53's main finding on Privy's library (PVY-01-002, rated High) was that a polynomial's leading coefficient could be
zero, which lowers its degree for that byte. Privy first forced non-zero coefficients, then in January 2025 went back to
uniform coefficients in [0, 255], citing the standard security proof. Cure53 also listed "non-resistance to cache
side-channel attacks" as informational [transcribed: Privy's blog posts and search summaries; the Cure53 report was not
read]. Rejecting zero coefficients is itself a small leak: in a 2-of-n set a non-zero slope means that every byte of
the secret differs from the byte at the same position in any one share, so one share rules out one of 256 values per
byte [inferred]. Sixkey therefore samples uniformly and rejects nothing (§3.3).

### 1.3 Inheritance and emergency access elsewhere

| Product | How access starts | Who enforces the wait | Cryptography | Notes |
|---|---|---|---|---|
| **Bitwarden** Emergency Access | The grantee requests; the grantor is emailed and can approve or reject; access is granted when "the wait time lapses" [verified: help page] | **The server.** A scheduled job, `HandleTimedOutRequestsAsync`, sets expired requests to `RecoveryApproved` [verified: `bitwarden/server`, `EmergencyAccessService.cs`] | The grantee's RSA public key is fetched at the invitation; at confirmation the grantor's user key is encrypted to it and stored on the server (`KeyEncrypted`) [verified: whitepaper and server source] | Grantor needs premium. Wait: 1, 2, 7, 14, 30 or 90 days, default 7 [verified: `bitwarden/clients`, `emergency-access-add-edit.component.ts`]. "View" (read only) or "Takeover" (sets a new master password and removes two-step login) [verified: help page] |
| **Proton** Emergency Access (announced 2025-08-28) | A contact requests; the owner can approve or deny; "If you do nothing, the request will automatically be approved after the designated waiting time" [transcribed, vendor blog] | Not stated [unverified: presumably the server] | "All of your data remains end-to-end encrypted"; the key mechanism is not described [transcribed, vendor] | Up to 5 contacts, each with a Proton account; paid plans only; the wait runs from days to months, or access can be immediate [transcribed, vendor] |
| **1Password** | No emergency-access or legacy-contact feature found. Staff on the community forum point to the Emergency Kit or a recovery code given to a trusted person [transcribed: community forum; no official article found] | — | — | Requests for "legacy contacts" were still open in 2024–2025 [transcribed] |
| **Apple** Legacy Contact | The contact presents the access key the owner generated **and a death certificate** (requirements vary by country) [verified: Apple support 102631] | Apple, by checking documents | Not described | iCloud Keychain data (passwords, passkeys, payment information) is **excluded** [verified] |
| **Google** Inactive Account Manager | Inactivity, judged from sign-ins, My Activity, Gmail use and Android check-ins; up to 10 contacts [verified: Google help 3036546]. Options of 3, 6, 12 or 18 months, with a warning a month before by text and email [transcribed: Google Security Blog 2021, via search; a secondary guide disagrees] | Google | Not end-to-end encrypted | This is the check-in model §4.4 rejects |

Takeaways [inferred]:

- Every end-to-end-encrypted product found uses **a request plus a waiting period**, and in the one whose code could be read
  (Bitwarden) the server enforces the wait. A dishonest server can release early in all of them. §4.3 has the same
  property and says so.
- Apple, which asks for proof of death, still excludes passwords and passkeys. A TOTP secret is the same kind of thing.
  This matters for the legal question (§1.5, §6).
- Google's model tracks the owner's activity continuously. Sixkey's zero-tracking promise rules that out (§4.4).

### 1.4 WebAuthn PRF [transcribed from QUICK-UNLOCK §0A, §1.5]

- Chrome evaluates PRF for passkeys in Google Password Manager and iCloud Keychain from an extension origin (QUICK-UNLOCK
  Mac runs 1–2, Chrome 154); both passkeys were synced (BE = BS = 1). A device-bound macOS credential with PRF is still
  unmeasured; Windows Hello is pending.
- Security keys provide PRF through `hmac-secret` (YUBIKEY-DESIGN).
- One `get()` can evaluate two PRF salts at once. This proposal relies on **not** doing that at unlock (§2.5).

From the WebAuthn Level 3 Recommendation (W3C, 25 August 2026) [verified]:

- the `prf` inputs are `eval: {first, second?}` and, for assertions with a non-empty `allowCredentials`,
  `evalByCredential`; `second` is optional;
- each input is hashed before it reaches `hmac-secret`: `salt1 = SHA-256(UTF8("WebAuthn PRF") ‖ 0x00 ‖ first)`, and the
  same for `second`.

So `salt` (unlock) and `hvkSalt` (step-up) give independent outputs. If an unlock asks for `first: salt` only, the
authenticator never computes the HVK's KEK during an unlock [inferred]. Whether synced platform passkeys return a `second`
output is not measured, and the design does not need it.

### 1.5 Law

Background for the legal review, not legal advice. All of this is [transcribed] from secondary sources unless marked.

- **United States.** The Revised Uniform Fiduciary Access to Digital Assets Act (RUFADAA, 2015) has been enacted in most
  states; sources give 37, 38 or "almost every state", and Massachusetts was listed as an exception. Under it, a user's
  direction given through a custodian's **online tool** overrides a conflicting will or trust; the order is online tool,
  then will or trust, then the custodian's terms, then the statute's defaults. Each state's text differs.
- **European Union.** The GDPR does not apply to deceased persons (Recital 27); member states may legislate. Germany: the
  Federal Court of Justice (BGH, III ZR 183/17, 12 July 2018) held that a social-network account contract passes to the
  heirs by universal succession (§ 1922 BGB), and that the GDPR does not stop the heirs' access. France has a statutory
  scheme of post-mortem directives [unverified: not fetched].
- **China.** Personal Information Protection Law, Article 49: when a natural person dies, the close relatives may, for
  their own lawful and legitimate interests, exercise the rights of access, copying, correction and deletion over the
  deceased's personal information, unless the deceased arranged otherwise before death [transcribed: text from secondary
  reprints, not the official gazette]:
  - 自然人死亡的，其近亲属为了自身的合法、正当利益，可以对死者的相关个人信息行使本法第四章规定的查阅、复制、更正、删除等权利；死者生前另有安排的除外。

What this means for Sixkey [inferred; for the legal review to confirm or correct]:

- A cloud heir arrangement probably counts as the owner's own direction ("online tool" under RUFADAA, "另有安排" under
  PIPL Art. 49), which may make it prevail over a will. The terms should say so plainly, and say that Sixkey does not judge
  who the lawful heirs are.
- The designated heir and the legal heirs may differ. Sixkey can give anyone else only metadata (that an arrangement
  exists), never content, because it cannot decrypt.
- The heir's email is a third party's personal data, processed on the owner's instruction.
- A TOTP secret opens other services' accounts; their terms and laws on account access after death apply too. Apple
  excludes such data even with a death certificate (§1.3).

---

## 2. Feature A: protected accounts (tiers)

### 2.1 Scope

- Each account is either **everyday** (tier 1, as today) or **protected** (tier 2).
- A protected account's **secret** is encrypted a second time, under the HVK. Its name, issuer, icon, group, order and
  domains stay readable with the VK, so it can still be listed, searched and sorted.
- Seeing a protected code, copying it, showing its secret or QR code, editing its secret, exporting it and un-protecting it
  all need a **step-up** (§2.5): the master password, the recovery key (or two shares), or a PRF credential enrolled for
  this purpose.
- **Never** a step-up: the PIN, the Touch ID / Windows Hello gate without PRF, the Phase 0 device key, or an unlocked
  session.
- Requires a master password. Not offered on a Phase 0 device-key vault (it has no password to step up with).
- Two tiers only. More levels would add UI and no new protection [inferred].

### 2.2 Threat model

| Attacker (SYNC-DESIGN §1.2 / QUICK-UNLOCK §2 names) | Today | With protected accounts |
|---|---|---|
| Someone at the computer while Sixkey is unlocked or PIN-unlocked (family, coworker, a thief who grabs an open laptop) | every code | everyday codes only; protected codes need the password or the security key |
| Someone who knows or guesses the PIN (5 tries) | every code, until the 12-hour cap | everyday codes only |
| A program or developer tools reading `chrome.storage.session` (T4) | the VK, so every secret | the VK, so everyday secrets. The HVK exists only in one page's memory for at most 5 minutes after a step-up; a debugger attached to that page at that moment can read it [inferred] |
| A copy of the profile, attacked offline (A3) | guess the password, then every secret | **no change**: the HVK is wrapped under the same password |
| The server or a stolen server database (A1) | guess the password from the bundle | **no change** |
| Phishing for the master password | every secret | every secret |
| Older copies after an account is protected | — | snapshots (up to 7 days locally) and cloud history (up to 30 days unless cleared) still hold the old secret under the VK only; §2.11 |

**Honest summary for users:** protected accounts protect against someone who gets into an unlocked or PIN-unlocked
Sixkey, not against someone who learns the master password.

### 2.3 Cryptography

**The HVK.** 32 random bytes, created once per vault, **never stored anywhere except inside the keyring's password and
recovery wraps** (and, optionally, a PRF wrap; §2.8).

- `hvkId = hex(HKDF-SHA256(HVK, ∅, "sixkey/v1/hvk-id", 64 bits))`, like `vkId`.
- `K_seal = HKDF-SHA256(HVK, ∅, "sixkey/v1/hvk-seal") → AES-256-GCM`.

**Keyring v2: one wrap carries both keys.** The password wrap and the recovery wrap encrypt `VK ‖ HVK` (64 bytes) instead
of `VK` (32 bytes):

```ts
type WrappedKeyV2 = {
  method: "password" | "recovery";
  vkId: string;
  hvkId: string;                 // new; 16 lowercase hex
  kdf: KdfParams;
  iv: string;                    // 12 bytes, base64
  wrapped: string;               // base64 AES-GCM(KEK, VK ‖ HVK): 64 + 16 = 80 bytes
  createdAt: number;
};
// AAD: "sixkey-wrap|2|{method}|{vkId}|{hvkId}|{vaultId}|{kdfDescriptor}"
type KeyringV2 = { format: "sixkey-keyring"; v: 2; vaultId; vkId; wraps: WrappedKeyV2[]; previous: PreviousVk[] };
```

- Every wrap of a v2 keyring carries the same `hvkId`. A keyring is either v1 (no HVK) or v2 (all wraps carry it); there is
  no mixed state, because the upgrade happens only when both secrets are in hand (§2.10).
- `previous` is unchanged: it holds old VKs wrapped by the current VK. HVKs never go into it (a VK holder must not get an
  HVK).
- Phase 0 `device` wraps stay v1. Tiers are not offered there.
- v1 keyrings stay readable forever (SYNC-DESIGN §2.6: readers are never dropped).

**Why not a separate HVK member in the keyring?** Putting the HVK inside the existing wraps:

- adds no new wrap method, so `keybundle.ts:67` ("wraps must be exactly password and recovery") and the server's P4 consistency rule
  stay as they are;
- makes every existing key operation carry the HVK automatically. A password change, a new recovery key or a rotation
  rewrites the wraps, and the HVK goes with them in the same locked save. A separate member would need its own rewrap in
  every one of those operations, with its own crash windows [inferred];
- costs one PBKDF2 per step-up, the same as an unlock with the password.

**Why the HVK never rotates.** A rotation (SYNC-DESIGN §3.10 R3) makes a new VK and rewraps `VK_new ‖ HVK`; the HVK stays.

- Protected secrets are sealed **inside** the VK-encrypted envelope. Anyone who reads future versions needs the new VK as
  well as the HVK, so rotating the VK already cuts off a revoked device [inferred].
- The HVK is never stored on a device. A stolen device, locked or in a PIN session, never contains it.
- A rotating HVK would need its own `previous` list to keep old snapshots readable, which is the kind of mechanism this
  proposal tries not to add.
- Residual: someone who once learned the HVK (for example by watching a step-up in a debugger) **and** later obtains the
  current VK can read protected secrets. Both are needed, and the first is a 5-minute window.

**Sealing a secret.**

```ts
type Seal = { k: string /* hvkId */; c: string /* base64(iv(12) ‖ AES-GCM(K_seal, pad64(UTF-8(secret)))) */ };
// AAD: "sixkey-seal|1|{vaultId}|{hvkId}|{entryId}"
// pad64: append ASCII spaces to the next multiple of 64 bytes; base32 secrets contain no spaces; unpad = trim the end.
```

- The AAD binds the vault, the key and the entry, so a sealed secret cannot be moved to another entry.
- Padding hides the secret's length from a VK holder [inferred: most TOTP secrets are 16 or 32 base32 characters, so the
  length would say little anyway; the padding is cheap].
- All primitives are WebCrypto: HKDF-SHA256, AES-256-GCM, PBKDF2-SHA256. No dependency.

### 2.4 Vault format and merge

**Entry fields** (all optional; absent means "everyday, as today"):

```ts
type Entry = {
  // … existing fields …
  secret: string;                // "" when sealed (or purged)
  seal?: Seal;                   // in the CONTENT register, stamped by hlc, like secret
  tier?: 2;                      // the PROTECTION register
  thlc?: Hlc;                    // its stamp
};
```

**Merge** (`mergeEntry`):

- The content register (now including `seal`) keeps the side with the later `hlc`, as today.
- The protection register `(tier, thlc)` keeps the side with the later `thlc`; on an exact tie, `tier: 2` wins.
- The two registers are independent, so four states can result. The first and last are normal; the middle two are
  temporary and must be settled:

| `tier` | content | Meaning | Shown as | Settled by |
|---|---|---|---|---|
| 2 | sealed | protected | protected | — |
| 2 | plain | **seal pending**: another device edited the entry before it heard of the protection | **protected** (code hidden, step-up required). Until it is sealed, its secret is readable with the VK alone, so Settings › Protected accounts shows "protection pending" | the next page that holds the HVK seals it with a new `hlc` |
| 1 (absent) | sealed | **unseal pending** | needs a step-up (it is sealed) | the next page that holds the HVK unseals it |
| 1 (absent) | plain | everyday | everyday | — |

- Why two registers: with one register, an offline device that renames an entry after another device protected it would win
  the merge and silently un-protect it. With two, the protection survives and the newest secret survives too: no data is
  lost [inferred, to be covered by a merge property test].
- Merge stays commutative, associative and idempotent (both registers are last-writer-wins with a total tie-break).

**Other rules:**

- `isPurged(e)`: `secret === "" && !seal`. `purgeEntry` removes `seal` with the secret and leaves the protection register
  as it is.
- `schemaVersion` (derived): **3** if any entry that is not purged has `seal` or `tier`; else 2 with YubiKey reference
  entries; else 1. A reader of 3 also reads 2. An older client meets 3, stops with `newer_schema` and loses nothing.
- `validate.ts`: `seal.k` must be 16 lowercase hex and `seal.c` base64 of at least 12 + 64 + 16 bytes. A seal whose `k` is
  not the keyring's `hvkId` is kept as it is (never dropped) and shown as "protected with a key this vault does not have"
  [inferred: should not happen, because the HVK never changes; it can after a mistaken import].
- `addAccountsFrom` (import from another vault, including the local accounts imported at a join, SYNC-DESIGN §3.5): sealed
  entries of the other vault must be unsealed with **that** vault's HVK first. If the local vault has protected accounts,
  the join asks for the local master password at the import step. The entries arrive as "seal pending" with `tier: 2`
  and are sealed at the first step-up in the joined vault. Until then they stay in `sk_prejoin` as well (it is kept until
  the import is confirmed).

### 2.5 Step-up: what opens protected codes, and for how long

**Accepted:**

1. the master password: `verifyPassword` unwraps the v2 password wrap, which yields the HVK;
2. the recovery key, or two shares (§3): the recovery wrap;
3. a PRF credential that has an HVK wrap (§2.8): a security key, or a platform passkey, with QUICK-UNLOCK's opt-in rule for
   synced passkeys.

**Where the HVK lives:** only in the JavaScript memory of the page that did the step-up (the popup or a Sixkey tab).

- It is never written to `chrome.storage.local`, `chrome.storage.session`, IndexedDB, the mirror, a log, the diagnostics
  file or the security record.
- It is never posted to the service worker or another page.
- It is not part of `sk_session` or `sk_quick`.

**The window ends** at the first of:

- the page closing (the popup closes when it loses focus);
- any lock, soft or hard (`sk_lock_epoch` changes);
- **5 minutes** after the step-up (fixed, not extended by use);
- the user pressing "Hide protected codes".

**A password unlock counts as a step-up** for the page where the password was typed, because the same unwrap yields both
keys. A PIN or gate unlock does not.

**Cost:** one PBKDF2 (about the time of an unlock with the password) or one authenticator touch.

### 2.6 List, search, copy and site matching

- A protected account is listed and searchable by name like any other, with a small lock badge. Its code is replaced by
  "Protected" and a **Show** button that starts the step-up. After the step-up, its code shows and copies like any other
  until the window ends.
- **Names stay visible.** Hiding them would also hide them from search and from the user's own list, for little gain: the
  name says the account exists, not its code [inferred]. A "hide the name as well" option is left out of v1.
- Pinned accounts and site matching (`match.ts`) work as today, but a protected match shows the lock and the Show button.
- Showing the secret or QR code, editing the secret, exporting and un-protecting all need the HVK in the page.
- Renaming, regrouping, reordering, deleting and restoring a protected account do **not** need a step-up: they do not touch
  the seal.

### 2.7 Export, backup and import

- **Exports** already need the master password (QUICK-UNLOCK §5.1 item 6), so the page has the HVK: protected secrets are
  exported in clear like the others.
  - Sixkey's own export format gets `"protected": true` per entry, so a re-import keeps the tier.
  - Third-party formats (otpauth URIs, QR codes) cannot carry it. The dialog says "{n} protected accounts will be exported
    without their protection".
- **Encrypted backup file** (`sixkey-backup` v1, unchanged): it must not depend on the HVK, so protected entries are written
  unsealed with `tier: 2` (the backup password protects them, as it protects everything in the file). On restore they come
  in as "seal pending" and are sealed at the first step-up. A backup of a vault with protected accounts carries a
  schemaVersion 3 vault; an older app refuses it as newer and changes nothing.
- **Import from other apps:** v1 imports as everyday. The import summary offers "Protect these" for entries that match the
  high-value list (§2.12).

### 2.8 QUICK-UNLOCK interplay

This makes the PIN safer: the worst case of a stolen PIN session is now "everyday codes".

- `sk_quick` and the gate keep the **VK only**, as designed. Nothing changes in QUICK-UNLOCK Stage 1.
- **QUICK-UNLOCK Stage 2 (PRF)** adds an optional HVK wrap per credential, for step-up only:

```ts
type PrfCred = {
  // … QUICK-UNLOCK §5.2 fields …
  hvkSalt?: string;              // 32 random bytes, distinct from salt
  hvkWrap?: { hvkId: string; iv: string; wrapped: string } | null;
  // KEK = HKDF-SHA256(PRF(hvkSalt), ∅, "sixkey/v1/kek-prf-hvk")
  // wrapped = AES-GCM(KEK, HVK, AAD "sixkey-prf-hvk|1|{vaultId}|{hvkId}|{credId}")
};
```

  - An unlock asks the authenticator for `salt` only. A step-up asks for `hvkSalt` only, in a separate `get()`, so seeing a
    protected code always takes a fresh touch. **Requesting both salts at unlock is forbidden** (a test and a mutant).
  - The HVK wrap is offered only on credentials whose mode is `prf`. A gate credential holds no key and cannot step up.
  - Synced passkeys follow QUICK-UNLOCK Q2: allowed for the HVK wrap only after the same opt-in.
- QUICK-UNLOCK §5.1 item 6 (operations that need the master password) gains: un-protecting an account. Viewing a
  protected code needs the master password or a PRF step-up.
- The honest PIN label can add: "Protected accounts always need your password or security key."

### 2.9 Sync, contract and vectors: exact changes

**SYNC-DESIGN** (one revision, when approved):

| Section | Change |
|---|---|
| §2.1 layering | `KEK ──AES-GCM──> VK ‖ HVK`; `HVK ──HKDF──> K_seal`, `hvkId` |
| §2.2 labels | HKDF `sixkey/v1/hvk-id`, `sixkey/v1/hvk-seal`; AAD tags `sixkey-wrap|2|` (wraps v2) and `sixkey-seal|1|`; with QUICK-UNLOCK Stage 2, `sixkey/v1/kek-prf-hvk` and `sixkey-prf-hvk|1|` |
| §2.3 KeyBundle | the synced keyring is **v2**: every wrap carries the same `hvkId`; `wrapped` is 80 bytes; `previous` unchanged; a bundle whose `hvkId` differs from the pinned one is refused (client) and rejected with 422 (server, comparing with the current bundle) |
| §2.6 crypto-agility | keyring `v: 2`; the wrap AAD version `|2|` |
| §3.1 step 4 | if the local keyring is v1, upgrade it to v2 (new HVK) in the same locked save, before the first upload; both secrets are in hand there |
| §3.2 enrolment payload | **unchanged**: P carries the VK only. The new device obtains the HVK from the bundle's password wrap at its first password unlock |
| §3.3 recovery join | the recovery wrap yields `VK ‖ HVK` |
| §3.9 adoption | pin `hvkId` with `vkId` |
| §3.13 formats | rows for keyring v2 and for entry fields `seal`, `tier`, `thlc` (schemaVersion 3) |
| §8, §10 | tests and attack rows for §2.2 |

**`api/openapi.yaml`:**

- `PasswordWrap` and `RecoveryWrap`: add `hvkId` to `required` and to `properties` (`$ref` `VkId`, 16 lowercase hex);
  `wrapped` becomes a new `B64Bytes80`. 80 bytes is not a multiple of 3, so unlike `B64Bytes48` (`^[A-Za-z0-9+/]{64}$`)
  its standard base64 is 108 characters with one `=`: pattern `^[A-Za-z0-9+/]{106}[AEIMQUYcgkosw048]=$`, description
  "80 bytes, standard base64 (wrapped VK ‖ HVK: 64 + 16-byte tag)".
- `PreviousVk.wrapped` stays `B64Bytes48` (old VKs only, no HVK).
- `SyncKeyring`: `v` becomes `const: 2`, and its description changes from "Phase 0 keyring v1 …" to keyring v2.
- `KeyBundle` itself is unchanged (still `v: 1`; its keyring member changes shape).
- Size: the bundle grows by about 120 bytes [estimate].

**Server (`api/`):** the keyless keyring shape check accepts v2 wraps only; same `hvkId` in both wraps; `hvkId` equal to the
current bundle's (422 otherwise). P4 is unchanged: "wrap changed" is still judged on `iv` and `wrapped`.

**Vectors (`contract/vectors/sync-v1.json`)** and the Python reference:

- `keybundle`: recomputed with a v2 keyring;
- new `hvk` group: `hvkId`, `K_seal`, a seal and an unseal with padding and AAD, a wrong-entry AAD that must not open,
  and a v2 wrap that must not open under the v1 AAD;
- `labels`: two new HKDF labels and two new tags, all distinct from the existing ones;
- `envelope`: add a schemaVersion 3 plaintext example (the envelope itself is unchanged).

**Not changed:** the envelope format, the enrolment protocol, `pw_auth`, `K_write`, the request signatures.

### 2.10 Migration

Nothing has shipped, so only development vaults exist [transcribed from the recovery study §0.3 item 4: "At the first store
submission"].

- **New vaults** get a v2 keyring at creation: first run already sets the password and the recovery key before anything is
  written (`VaultService.prepareKeys`, QUICK-UNLOCK §0.2).
- **An existing v1 vault** is upgraded only when both secrets are in hand, never silently:
  - when the user first turns on protected accounts: Sixkey asks for the master password and then the recovery key, or
    offers to make a new recovery key (the shared step of §0.3);
  - or when sync is turned on (§3.1 step 4).
  - The upgrade is one locked save (`VaultStore.transact`).
- Until then the "Protect" action explains why it needs the recovery key once.

### 2.11 Never lose data

- The HVK is inside the same wraps as the VK, so **every way that opens the vault opens protected accounts too**: the
  password, the recovery key, two shares, and a security key with an HVK wrap. There is no key that can be lost on its own.
- Protecting, un-protecting and settling pending states are ordinary entry edits: they go through the store's crash-safe
  saves and snapshots like any other edit.
- The merge keeps both the protection and the newest secret (§2.4).
- Exports, backups and imports carry the tier and never depend on the HVK (§2.7).
- **Old copies are kept, by design.** When an account is protected, older snapshots, the mirror and the cloud history still
  hold its secret under the VK only, until they age out (7 days locally; the cloud history unless the user clears it).
  Deleting them early would break "never lose data". The protect dialog says so and suggests the stronger option: "For full
  protection, reset two-factor authentication on the site and add the new key as a protected account."

### 2.12 UX and defaults

- **Default:** nothing is protected. The add-account screen and the import summary suggest "Protect this account?" when
  the issuer or domain matches a short built-in high-value list (exchanges, banks and payments, email, domain registrars
  and DNS, cloud consoles, password managers). One tap, no nagging.
- **Marking:** the account menu has "Protect" / "Stop protecting"; Settings › Security › Protected accounts lists them and
  offers the high-value suggestions in bulk. Each change needs a step-up.
- **Popup:** the lock badge; "Show" starts the step-up (the password field, or "Use security key" / "Use Touch ID" when an
  HVK wrap exists); the codes stay for the window, with a small countdown and "Hide".
- **Copy (en / zh_CN):**

| Key | English | 中文 |
|---|---|---|
| `tierProtect` | Protect this account | 保护此账户 |
| `tierUnprotect` | Stop protecting | 取消保护 |
| `tierBadge` | Protected | 受保护 |
| `tierShow` | Show | 显示 |
| `tierHide` | Hide protected codes | 隐藏受保护的验证码 |
| `tierStepUpTitle` | Confirm it's you | 确认是你本人 |
| `tierStepUpBody` | Protected accounts need your password or security key. Your PIN is not enough. | 受保护的账户需要主密码或安全密钥，PIN 不够。 |
| `tierWindowLeft` | Visible for {minutes} more min | 还可显示 {minutes} 分钟 |
| `tierSuggest` | This looks like a high-value account. Protect it? | 这看起来是重要账户。要保护它吗？ |
| `tierOldCopies` | Older copies of this secret stay in your snapshots for up to 7 days and in cloud history until it is cleared. For full protection, reset two-factor on the site and add the new key as protected. | 这个密钥的旧副本会在快照里保留最多 7 天，在云端历史里保留到被清除为止。要完全保护，请在网站上重置两步验证，再把新密钥添加为受保护账户。 |
| `tierExportWarn` | {n} protected accounts will be exported without their protection. | 将导出 {n} 个受保护账户，导出后不再受保护。 |
| `tierNeedsRecovery` | To protect accounts in this vault, Sixkey needs your recovery key once, or can make you a new one. | 要在这个库里保护账户，Sixkey 需要你输入一次恢复密钥，或者为你生成一个新的。 |
| `tierPinLabel` | Protected accounts always need your password or security key. | 受保护的账户始终需要主密码或安全密钥。 |

### 2.13 Tests and mutants (outline)

- Unit: wrap v2 round trip; the v1 AAD does not open a v2 wrap; seal and unseal; wrong-entry AAD; padding; `hvkId`.
- Merge property tests (fast-check): commutative, associative, idempotent with the protection register; "an offline rename
  never un-protects"; "the newest secret survives a protect/rename race".
- Source rules: the HVK never reaches `chrome.storage`, IndexedDB, `postMessage`, logs or `sk_quick` (the same kind of test
  as `quick-source-rules.test.ts`).
- e2e: PIN unlock shows everyday codes and hides protected ones; step-up shows them for 5 minutes; a lock hides them at
  once; popup close drops them.
- Mutants:
  - HVK kept in `storage.session`;
  - the step-up window not ended by a lock;
  - a PIN accepted as a step-up;
  - both PRF salts requested at unlock;
  - the tie-break favouring tier 1;
  - `isPurged` ignoring `seal`;
  - the export dropping `"protected"`;
  - the v1 AAD accepted for a v2 wrap.

---

## 3. Feature B: recovery-key shares (Shamir)

### 3.1 Scope and the decision: the same recovery key

**Shares rebuild the existing 128-bit recovery key R.** They are an additional way to obtain R, nothing else:

- The keyring, the recovery wrap, the server's `recovery_verifier`, the recovery join (SYNC-DESIGN §3.3) and the local
  reset are unchanged. Wherever Sixkey accepts the recovery key, it also accepts "shares instead" (t of one set; "two shares" elsewhere in this document means the default 2-of-3).
- No new key, no new wrap, no new verifier, nothing to rotate and no contract change.
- **Revocation is a new recovery key** (an existing, crash-safe key operation): every share of the old key stops working at
  once.

Rejected alternative: a dedicated share-set key with its own keyring wrap. It would allow several independent share sets
and revoking one without changing the recovery key, but it adds a third wrap method, a server verifier per set, the P4
consistency rules, a rewrap in every key operation, and a contract change [inferred]. Not worth it for a feature whose
users make one set.

**Two ways to make shares:**

1. **"Replace my recovery key with shares"** (recommended default): Sixkey makes a **new** R, shows it **only** as shares and
   never as a single code, and commits the new key only after the test-restore succeeds (§3.6). No single paper with the
   whole key then exists.
2. **"Split my current recovery key"**: the user types the current R (Sixkey never stores it); Sixkey shows shares of it.
   The user's existing paper with R stays valid, which the screen says.

Thresholds offered: **2 of 3** (default) and **3 of 5**. The format allows up to 16.

### 3.2 Threat model

| Attacker | Gets | Result |
|---|---|---|
| Finds one share (2-of-3) | one share | nothing usable. Without the digest, one share would say nothing about R. The 4-byte digest lets a holder of one share discard candidate keys, which in theory leaves 96 of R's 128 bits unknown (SLIP-39's own caveat, §1.2); finding the survivors still means trying all 2¹²⁸ candidates [inferred] |
| Finds two shares | R | same as finding the recovery key today; still needs the vault data (a profile, a backup file, or email access for the cloud recovery join) |
| Photo or OCR malware on a phone where shares are photographed | as many shares as are photographed | same as above; the advice is "never photograph shares", and the format does not look like a wallet phrase (§3.4) |
| Phishing ("type your shares here") | what the user types | the share page says Sixkey asks for shares only on its own restore screen |
| A typo | a wrong share | the 20-bit check catches it locally; a wrong combination fails the digest check |

### 3.3 Format and arithmetic

**Arithmetic: SLIP-39's, for one group.** [SLIP-39, see §1.2]

- Bytewise Shamir over GF(2⁸) with the Rijndael polynomial `x⁸ + x⁴ + x³ + x + 1`, by Lagrange interpolation.
- For threshold t: t − 2 random shares, a **digest share** at x = 254 and the secret at x = 255. The digest share is
  `HMAC-SHA256(key = r, msg = R)[0..4] ‖ r`, where r is 12 random bytes for a 16-byte R.
- Member shares are the polynomial's values at x = 0 … n − 1.
- Recovery interpolates at 255 (R) and 254 (digest), and checks the 4-byte digest. A wrong combination of valid-looking
  shares fails with probability 1 − 2⁻³².
- Differences from SLIP-39: no Feistel layer, no groups, and Sixkey's own text encoding.
  - Without a passphrase the Feistel layer is a public permutation. R is uniformly random, so sharing a public permutation
    of R leaves an attacker with the same number of candidates as sharing R itself [inferred].
  - Partial leakage (SLIP-39's second caveat): parts of two shares visible at the same positions reveal those bytes of R.
    A partly visible recovery key leaks part of R in the same way today, so shares add no new kind of risk; the printed page
    says to keep each share whole and never photograph it [inferred].
- **Implementation rules**, taken from the reference and from the Privy audit history (§1.2):
  - random shares and the digest's random part come from `crypto.getRandomValues`, uniformly, and nothing is rejected
    (no "non-zero leading coefficient" rule);
  - no table indexed by secret bytes: multiplication by shift-and-XOR with masks, inversion as a²⁵⁴. That is a few thousand
    operations for a 16-byte key [estimate], and it removes the cache side channel that table lookups have. JavaScript gives
    no constant-time guarantee, so this is "algorithmically constant-time", as Privy puts it;
  - recovery uses exactly t shares of one set (same version, kind, set id and threshold) with distinct x coordinates below
    254; anything else is refused before any arithmetic;
  - the digest is compared in constant time, and intermediate buffers are zeroed after use (best effort in JavaScript).

**Text: Sixkey share v1, 180 bits = 36 Crockford base32 characters, 9 groups of 4.**

| Bits | Field |
|---|---|
| 4 | version = 1 |
| 4 | kind: 0 = recovery-key share, 1 = heir share (§4.3); others reserved |
| 16 | set id (random; the same in every share of a set) |
| 4 | threshold − 1 |
| 4 | member index x (0–15) |
| 128 | share value y (16 bytes) |
| 20 | check: the first 20 bits of `SHA-256("sixkey-share|1|" ‖ the first 20 bytes above)` |

- The tag differs from the recovery key's (untagged) and the pairing code's checks, and the length differs (36 against
  28), so no Sixkey code is accepted in another's field.
- Input normalisation as for the recovery key: any case, spaces and `-` ignored, O read as 0, I/L as 1.
- The check detects a random typo with probability 1 − 2⁻²⁰. It does not correct errors. The printed page uses large
  monospace groups to make typos rarer.
- **Crypto-agility.** A reader refuses an unknown version or kind and says "made by a newer Sixkey". A future version can
  change the length (for example, shares of a 256-bit key if PQ-READINESS ever raises the recovery key) or the check,
  without touching v1. Readers of v1 are never dropped (SYNC-DESIGN §2.6).

**Implementation:** about 200 lines of TypeScript in `core/crypto/shares.ts` [estimate]: table-free field arithmetic,
interpolation, the digest via WebCrypto HMAC, the codec via WebCrypto SHA-256. No dependency and no WASM. The same algorithm goes into the
Python reference (`contract/py`), with a `shares` vector group:

- fixed R and randomness, giving fixed share texts;
- recovery from every pair;
- bad check, mixed sets, the same share twice, a failing digest;
- a recovery key and a pairing code rejected as shares.

A test-only cross-check runs the share values against Trezor's reference implementation, `python-shamir-mnemonic`
(§1.2):

- It is MIT-licensed, compatible with `contract/py`'s Apache-2.0. It is used as a pinned **development** dependency
  (`shamir-mnemonic==0.3.0`) and never vendored or shipped.
- The cross-check calls the raw functions, `_split_secret(threshold, share_count, shared_secret)` and
  `_recover_secret(threshold, shares)`, with `shamir_mnemonic.shamir.RANDOM_BYTES` replaced by a fixed byte stream. Both
  are private names, which is why the version is pinned exactly [verified: `shamir.py`].
- The check: for fixed R and fixed random bytes, Sixkey's TypeScript, the Python reference in `contract/py` and Trezor's
  code produce the same raw share values, and each recovers R from every subset of size t.
- SLIP-39's own `vectors.json` is **not** copied into `contract/vectors` (CC0): it is MIT-licensed, and it tests the
  word-mnemonic path that Sixkey does not use. Sixkey's `shares` vectors are generated by Sixkey's own tools.
- Recommendation: an external review of `shares.ts` together with the protected-accounts change (§0.3), since both are new
  cryptographic code.

### 3.4 Why not SLIP-39's word mnemonics

- **Consistency with the recovery study's §1.7.** A Sixkey key in a wallet format looks like a wallet backup. Phishing kits
  ask for exactly that, and malware hunts for it. A SLIP-39 share set of a 128-bit secret is a valid Trezor backup.
- **One input component.** The recovery key, the pairing code and the shares all use the same grouped base32 field with
  the same typo rules.
- **What SLIP-39's words would add:** stronger error detection (RS1024 guarantees detecting up to 3 wrong words, §1.2
  [verified]) and recovery with third-party tools. The tools would only yield R, which still needs Sixkey's vault format
  and software. The format is open and the Python reference can rebuild R, so longevity does not depend on SLIP-39's
  wordlist [inferred].
- **Why not a library:** Privy's audited library uses its own share layout and leaves integrity checking to the caller;
  `slip39-js` brings the word path; `secrets.js-grempe` has not been released since 2019 (§1.2). The sharing core is small,
  and the cross-check in §3.3 ties it to the reference [inferred].
- **What we keep from SLIP-39:** the arithmetic, the digest check and its test discipline. Those are the parts where a
  mistake would lose data.

### 3.5 Interaction with the keyring and the recovery key

- **Shares change nothing on disk**, and Sixkey keeps no record of them. A record of share sets (which recovery key they
  belong to, who holds each) was considered and left out:
  - staleness can be found when it matters: shares that rebuild a valid R (the digest checks) which does not open the
    current recovery wrap belong to an older recovery key or another vault;
  - a local record would not reach the user's other devices anyway, and a synced one would be a vault format change.
- Every recovery-key change, on any device, warns: "If you made shares or an heir kit of your recovery key, they will stop
  working." The cloud inheritance arrangement is known to the server, so its warning is specific (§4.3).
- The recovery study's rename applies: "Recovery key" (恢复密钥), "Emergency kit" (应急包). The shares wizard is part of
  Settings › Recovery.

### 3.6 Never lose data

- **Commit only after a test restore.** With "Replace my recovery key", the new R is committed only after the user has
  typed back t of the new shares, chosen by Sixkey at random (two in a 2-of-3 set), and they rebuild the new R. Typing
  back the other shares too is offered, not required. A copying mistake in an untested share is still caught by its check
  bits whenever it is typed, and by "Check my shares" [inferred]. Until then the old recovery key stays in force. This is
  the same rule as SYNC-DESIGN §3.1 step 4's "type two groups back".
- **Check my shares** (Settings › Recovery, any time): type t shares; Sixkey rebuilds R and tries the current recovery
  wrap. It writes nothing. A yearly reminder is offered, off by default.
- **One share lost:** the other two still work. The screen recommends "Make new shares" (a new R), because the lost share
  may turn up in someone else's hands.
- **One share compromised:** the same, urgently. One share is useless alone, but with any other it is R.
- **Shares from different sets:** refused with "These shares are from different sets" (set id), before any arithmetic.
- **The recovery key changed after the shares were made:** the shares rebuild an R that does not open the vault. "These
  shares belong to an older recovery key." Nothing is written.

### 3.7 UX flows

1. **Make shares** (Settings › Recovery › Split into shares; needs the master password):
   choose 2-of-3 or 3-of-5 → choose "replace" or "split current" (the latter asks for R) → for each share, its own page:
   **Print** (one share per page, never all on one page) or **Save as a text file** (with a warning that synced download
   folders put it in the cloud). There is no copy button, because the system clipboard can leave the computer (SYNC-DESIGN
   §1.3, revision 27) → **test restore** (type t shares back) → commit (for "replace").
2. **Recover with shares**: on every screen that accepts the recovery key, "I have shares instead" → a 9-group input → after
   the first share: "Share 1 of set 7F2A; {t} needed" → … → R is rebuilt in memory and used exactly like a typed recovery
   key, then forgotten.
3. **Check my shares**, **Make new shares**: §3.6.

The printed page shows: "Sixkey recovery share {i} of {n}. Any {t} of the {n} shares rebuild your recovery key." It gives
the share in 9 large groups, the set id and date, and "Use it only in Sixkey › Restore › Use shares. Sixkey never asks for a
share by email, chat or phone. This is not a crypto-wallet phrase. Do not photograph it." It has a blank line "Held by:".

**Copy (en / zh_CN):**

| Key | English | 中文 |
|---|---|---|
| `sharesTitle` | Split your recovery key | 拆分恢复密钥 |
| `sharesIntro` | Make {n} shares. Any {t} of them rebuild your recovery key; fewer reveal nothing. Keep them in different places. | 生成 {n} 份分片。任意 {t} 份即可重建恢复密钥，少于 {t} 份则不会泄露任何信息。请分开存放。 |
| `sharesReplace` | Make a new recovery key, shown only as shares (recommended) | 生成新的恢复密钥，只以分片形式显示（推荐） |
| `sharesSplitCurrent` | Split my current recovery key | 拆分我现在的恢复密钥 |
| `sharesPrint` | Print share {i} | 打印第 {i} 份 |
| `sharesSaveFile` | Save as a text file | 另存为文本文件 |
| `sharesTestTitle` | Check {t} shares before we switch | 切换前先核对 {t} 份分片 |
| `sharesInsteadLink` | I have shares instead | 我有分片 |
| `sharesProgress` | Share {k} of set {set}: {t} needed | 第 {k} 份（分片组 {set}），共需 {t} 份 |
| `sharesWrongCheck` | This share has a typo. Compare it with the paper. | 这份分片有输入错误，请对照纸上的内容核对。 |
| `sharesDifferentSets` | These shares are from different sets. | 这些分片来自不同的分片组。 |
| `sharesStale` | These shares belong to an old recovery key and no longer open your vault. Destroy them and make new ones. | 这些分片属于旧的恢复密钥，已无法打开你的库。请销毁并重新生成。 |
| `sharesLost` | Lost a share? Make new shares; the old ones stop working. | 丢了一份？重新生成分片，旧的会全部失效。 |
| `sharesNotWallet` | Use only in Sixkey › Restore. This is not a crypto-wallet phrase. Never photograph it. | 只在 Sixkey › 恢复中使用。这不是加密钱包助记词。不要拍照。 |

---

## 4. Feature C: inheritance

### 4.1 Scope

"Inheritance" means the heir ends up with **a copy of the owner's accounts in the heir's own Sixkey**. The owner's vault is
never modified, and the heir never joins it as a device. The heir needs two things: R (or the shares that rebuild it)
and the vault data (a browser profile, a backup file, or the cloud copy).

### 4.2 Variant 1: the manual inheritance kit (local, free)

- It uses §3 unchanged: a 2-of-3 share set of R.
  - Share 1 stays with the owner.
  - Share 2 goes to the heir.
  - Share 3 goes where the heir can get it only after the owner's death: a will, a lawyer, a safe-deposit box.
- An **inheritance letter** is printed with share 2. It says what Sixkey is, how to restore with shares, and where the data
  is. The owner ticks one or more:
  - "this computer, in Chrome's profile {name}";
  - "an encrypted backup file at {place}; its password is written {where}";
  - "Sixkey Cloud, account {email}".
    The letter must say that the cloud recovery join needs access to that email (SYNC-DESIGN §3.3). Email providers have
    their own processes for heirs, such as Google's Inactive Account Manager and Apple's Legacy Contact (§1.3); the letter
    suggests setting one up.
- **Honest limits:**
  - nothing detects inactivity: whoever holds two shares has access, at any time;
  - the owner chooses the holders accordingly;
  - changing the recovery key cancels the kit (§3.5).

### 4.3 Variant 2: cloud release (heir-initiated request with a waiting period)

**Recommendation: no check-ins.** The heir asks; the owner is notified; if the owner does not reject within the waiting
period W, the server releases. The owner's silence for W days is the inactivity proof. §4.4 explains why this is better than
a dead-man's switch.

**Key material:** a **2-of-2** share set of R, of kind 1 (heir), separate from any 2-of-3 set:

- **B**, the heir share, printed in the heir kit;
- **C**, the cloud share, uploaded encrypted under a key derived from B.

Shares of different sets do not combine, so B cannot be used with the owner's other shares [inferred from §3.3: each set is
its own polynomial].

From B's 16-byte value `y_B` and its 4-byte header `hdr_B`:

```
K_heir      = HKDF-SHA256(y_B, salt = hdr_B, "sixkey/v1/heir-key")     → AES-256-GCM
heir_auth   = HKDF-SHA256(y_B, salt = hdr_B, "sixkey/v1/heir-auth")    256 bits
heir_lookup = HKDF-SHA256(y_B, salt = hdr_B, "sixkey/v1/heir-lookup")  128 bits
c_ct        = base64(iv ‖ AES-GCM(K_heir, hdr_C ‖ y_C, AAD "sixkey-heir|1|{heir_lookup b64u}"))
verifier    = SHA-256("sixkey-heir-verifier|1|" ‖ heir_auth)
```

- B is close to uniformly random: its last 12 bytes are masked by the digest share's 12 random bytes, and its first 4 bytes
  mix the uniform R with the HMAC digest. So it carries at least 96 bits of entropy even under a pessimistic count, and
  about 128 in practice. The three derived values are as strong as that [inferred].
- **No public-key cryptography at all.** The heir does not need to register in advance, and the stored `c_ct` is safe
  against "record now, decrypt later" (PQ-READINESS) [inferred].

**Owner setup** (Settings › Inheritance; sync on; needs the master password, and R typed, or two shares, or a new R):

1. The owner enters the heir's email and chooses W: 7, 14, **30** (default), 60 or 90 days.
2. The client splits R into B and C, derives the values above, and sends them with a device signature and `pw_auth`:
   `{heir_email, wait_days, heir_lookup, verifier, c_ct}`.
3. The client prints the **heir kit**. It contains B; "To claim: install Sixkey › I'm an heir"; the waiting period; a
   handwritten line for the owner's name. It says that Sixkey cannot open anything without this paper.

**Heir claim:**

1. In Sixkey, "I'm an heir": the heir types B, then verifies the heir email by OTP.
2. `POST /v1/heir/requests {heir_lookup, heir_auth}` (heir email session). The server compares the verifier in constant
   time and checks the email.
   - A match creates a **pending** request with `release_at = now + W`.
   - A mismatch is rate-limited like the recovery join.
3. The owner is notified:
   - an email at once, then weekly, then 3 days and 1 day before `release_at`;
   - a banner on every owner device at its next sync (a field in `GET /v1/sync/status`).
4. The owner can reject:
   - from any device (device-signed);
   - or with the single-use link in the email, which can only reject.
   - A rejection notifies the heir and starts a 30-day cooldown before the next request.
5. After `release_at`, `GET /v1/heir/release` (heir session plus `heir_auth`) returns `c_ct`, the current KeyBundle and the
   current envelope, both as raw text. It stays available for 30 days.
6. The heir's client:
   - decrypts C and combines B with C into R;
   - opens the recovery wrap, which yields `VK ‖ HVK`, so protected accounts come too;
   - decrypts the envelope, shows the accounts, and offers "Copy into my Sixkey".
   - R, VK and HVK are then forgotten.
7. The owner is told "released to your heir on {date}". If the owner is alive and did not want this, they must make a new
   recovery key and reset the two-factor secrets of their accounts. The release cannot be taken back.

**Owner controls at any time** (device-signed with `pw_auth`):

- change W or the heir email;
- delete the arrangement: the server deletes `c_ct`, and B on paper becomes useless.

**Interaction with other operations:**

| Operation | Effect on the inheritance arrangement |
|---|---|
| Password change, VK rotation | none: the recovery wrap is rewritten under the same R |
| A new recovery key | **cancels** it. The client deletes `c_ct` in the same flow and asks the owner to make a new kit (the new R is in hand during that flow) |
| Account deletion | deletes it |

**Endpoints (additive, after sync launches; sketch, not a contract):**

| Endpoint | Caller | Action |
|---|---|---|
| `POST /v1/heirs` | owner | create |
| `PUT /v1/heirs` | owner | change W or the heir email |
| `DELETE /v1/heirs` | owner | delete the arrangement |
| `POST /v1/heir/requests` | heir | request access |
| `POST /v1/heir/requests/{id}/reject` | owner, or the email link | reject |
| `GET /v1/heir/release` | heir | fetch the release |

With the endpoints, a `heir` vector group: `K_heir`, `heir_auth`, `heir_lookup`, `verifier` and `c_ct` from fixed B, C
and IV; a wrong `heir_lookup` in the AAD that must not open; B with a share of another set that must be refused.

### 4.4 Why not a dead-man's switch with check-ins

The maintainers' alternative: release after N days of inactivity, proven by missed check-ins or unanswered email
challenges.

| | Check-ins | Heir request + waiting period |
|---|---|---|
| Server tracks the owner's activity | yes, continuously (conflicts with "zero tracking") | no; only one request's timestamps |
| False trigger (a long hospital stay, a lost email account) | possible after N days without the owner noticing | possible after W days, but the owner has been warned from day 1 by email and on every device |
| An heir who does not know what to do | waits for an automatic release | must act, but the kit tells them what to do |
| Mechanisms | a schedule, challenges, reminders, a trigger | one request, notifications, one timer |

The request model deletes the activity tracking. An automatic heir request after N months of silence can be added later,
if users ask for it [inferred].

### 4.5 Threat analysis

| Who | Can | Cannot |
|---|---|---|
| The server alone, or a stolen database | see that an heir exists, the heir email, W and the timestamps | read `c_ct` (AES-256 under a key from a 128-bit share), guess `heir_auth` or `heir_lookup`, or open anything |
| **Server + a stolen heir kit** | combine B and C into R, then open the latest vault it stores | — this is the inherent "two shares" case. Advice: keep the kit like the recovery key |
| **A dishonest server (or an insider) and the heir** | release early, ignoring W | — **the waiting period is a promise of the service, not cryptography.** Bitwarden's waiting period has the same property: its server stores the key encrypted to the grantee from confirmation onwards, and a server job grants access when the wait expires [verified: server source, §1.3]. The UI says: "Choose an heir you would trust with these accounts today." |
| The heir alone, before release | hold B | anything: B alone is one share of a 2-of-2 set |
| Someone with the heir's email only | nothing | start a request: it needs B (`heir_auth`) |
| Someone with the owner's email | reject a request (harmless) | create, change or delete the arrangement (each needs a device signature and `pw_auth`) |
| An heir who keeps requesting | one pending request, a 30-day cooldown after a rejection | flood the owner |
| A future quantum computer | — | anything: the stored material is symmetric. TLS is covered by SYNC-DESIGN M8 item 18 |
| **The owner, absent for W days while alive** | — | — this is the residual: a wrongful release. The owner chooses W; the default is 30 days |

**What the server learns:**

- that the owner has an heir, and the heir's email (personal data of a third party; §4.6);
- W, and when a request, rejection or release happened;
- the size of `c_ct` (constant).

It never learns B, C, R, the VK, the HVK or any vault content.

### 4.6 Law, money and open source

- **Legal** (owner question 1):
  - The release happens with no proof of death and no identity check beyond the email and B. Sixkey cannot verify death
    and, being zero-knowledge, cannot inspect what it releases.
  - The terms must say exactly this.
  - The heir's email is a third party's personal data, processed on the owner's instruction.
  - Rules on fiduciary access and on the data of deceased people differ by jurisdiction (§1.5: RUFADAA in the United
    States, national law in the EU, PIPL Art. 49 in China). An external legal review is needed before launch.
- **Money** (owner question 2):
  - The cloud release needs the hosted server, so it belongs to the paid cloud. Its code is open source in `api/`, so
    self-hosters get it too.
  - Protected accounts, shares and the manual kit stay free and are never gated.
  - Lapsed payment after a death: a paid account whose payment stops after the owner's death must not be deleted before the
    heir can claim. That needs a retention rule, for example "kept at least W + 90 days after payment stops while an
    arrangement exists" [estimate].

### 4.7 Copy (en / zh_CN)

| Key | English | 中文 |
|---|---|---|
| `heirTitle` | Inheritance | 继承 |
| `heirIntro` | Choose someone who can get a copy of your accounts if you can no longer use them. They ask; you get {days} days to say no. | 指定一个人：当你无法再使用这些账户时，他可以取得一份副本。他提出申请后，你有 {days} 天时间拒绝。 |
| `heirTrust` | Choose an heir you would trust with these accounts today. The waiting period is a promise of the Sixkey service, not something cryptography enforces. | 请选择一个你今天就愿意托付这些账户的人。等待期是 Sixkey 服务的承诺，而不是由密码学保证的。 |
| `heirKitTitle` | Heir kit | 继承包 |
| `heirKitBody` | This paper is one half of a key. Sixkey cannot open anything without it, and it opens nothing on its own. | 这张纸是一把钥匙的一半。没有它，Sixkey 什么也打不开；单凭它，也什么都打不开。 |
| `heirClaim` | I'm an heir | 我是继承人 |
| `heirRequested` | {heir} has asked for a copy of your accounts. It will be released on {date} unless you reject it. | {heir} 申请获取你的账户副本。除非你拒绝，否则将在 {date} 发放。 |
| `heirReject` | Reject | 拒绝 |
| `heirReleased` | A copy of your accounts was released to your heir on {date}. If you did not want this, make a new recovery key and reset two-factor on your accounts. | 你的账户副本已于 {date} 发放给继承人。如果这不是你的意愿，请生成新的恢复密钥，并重置各账户的两步验证。 |
| `heirCancelledByNewKey` | A new recovery key cancels your inheritance arrangement. Make a new heir kit. | 新的恢复密钥会取消你的继承安排，请重新制作继承包。 |
| `heirLetterTitle` | Inheritance letter | 继承说明信 |

---

## 5. Order, effort, and what changes where

### 5.1 Order and effort [estimate]

Covered in §0.3:

1. protected accounts, 3–4 weeks + review;
2. shares, 1.5–2 weeks;
3. the manual kit, 3–5 days;
4. cloud inheritance, 4–6 weeks + legal review + security review, after sync launches.

Shared first step: one "enter your recovery key, two shares, or make a new one" component.

### 5.2 Before sync ships

§0.4: keyring v2 and the schemaVersion 3 reader. Nothing for shares or inheritance.

### 5.3 Changes other documents would need (on approval)

| Document | Change |
|---|---|
| `docs/SYNC-DESIGN.md` | §2.9 table of this proposal, as one revision with a change-log entry |
| `api/openapi.yaml`, `api/` server checks, `contract/vectors`, `contract/py` | §2.9 |
| `QUICK-UNLOCK.md` | §5.2 `PrfCred.hvkSalt` / `hvkWrap`; §5.1 item 6; the PIN label |
| `YUBIKEY-DESIGN.md` | a security key's PRF credential may carry an HVK wrap (§2.8) |
| `RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md` | none; its naming ("Recovery key", "Emergency kit") is used here |
| `docs/security/local-vault.md` | protected accounts and their limits (§2.2, §2.11); shares; the manual kit |

---

## 6. Owner questions

1. **Cloud inheritance and liability.** It releases a copy with no proof of death, after a waiting period that the service
   (not cryptography) enforces. Choose one:
   - (a) build it after sync launches, only after an external legal review of the terms and the release policy;
   - (b) ship only the manual kit;
   - (c) both: **the manual kit with shares now, the cloud release later under (a) (recommended).**
2. **Scope and money.**
   - (a) Cloud inheritance is part of the paid cloud (it needs the hosted server; the code stays open source). Protected
     accounts, shares and the manual kit are free and never gated. **Recommended: yes.**
   - (b) Retention: keep an account with an heir arrangement for at least W + 90 days after its payment lapses. **Recommended:
     yes.**
3. **Naming** (recommended first):
   - "Protected accounts" / 受保护账户 (alternatives: "High-security accounts" / 高安全账户; "Vault tiers" is too technical);
   - "Recovery key shares" / 恢复密钥分片 (alternatives: "Shamir backup" / Shamir 备份, the older wallet term; Trezor now
     says "Multi-share Backup", §1.2);
   - "Inheritance" / 继承, with "Heir" / 继承人 and "Heir kit" / 继承包 (alternatives: Apple's "Legacy contact" / 遗产联系人;
     Bitwarden's "Emergency access" / 紧急访问, which suggests something other than death).

---

## 7. Unverified claims

1. Whether Proton's emergency-access waiting period is enforced by its server. This is assumed, as for Bitwarden, whose
   code was read (§1.3).
2. Whether `slip39-js` or `secrets.js-grempe` has ever been audited. None was found (§1.2).
3. The content of the Cure53 and Zellic reports on Privy's library, including finding PVY-01-002 and the cache side-channel
   note. Taken from Privy's README, its blog posts and search summaries; the reports were not read (§1.2).
4. Google Inactive Account Manager's current period options (3, 6, 12, 18 months) and its one-month warning. Google's 2021
   blog post, read through a search summary, disagrees with a secondary guide (§1.3).
5. That 1Password has no emergency-access feature. Based on community posts; no official statement was found (§1.3).
6. The legal points of §1.5: the RUFADAA adoption count and precedence order (law-firm summaries), the BGH ruling (press
   summaries), the French post-mortem directives (not fetched) and the PIPL Article 49 wording (secondary reprints).
7. Whether synced platform passkeys (Google Password Manager, iCloud Keychain) return a `prf` result for `second`. The
   design does not need it (§1.4).
8. Inherited from QUICK-UNLOCK: PRF on a device-bound macOS credential and on Windows Hello, pending its Stage 0 probe
   (§1.4).
9. Trezor's list of wallets that support Multi-share Backup (vendor page, §1.2).

## 8. Sources

**This repository** [verified]:

- `extension/src/core/crypto/keyring.ts` (wrap AAD, line 54), `recovery-code.ts`, `kdf.ts`, `pin.ts`
- `extension/src/core/sync/crypto/keybundle.ts` (lines 30 and 67: wraps exactly password and recovery)
- `extension/src/core/vault/model.ts`, `merge.ts`, `ops.ts` (`ContentPatch`, `purgeEntry`), `validate.ts` (line 112,
  `newer_schema`)
- `extension/src/core/backup/backup.ts` (line 2)
- `extension/src/platform/session.ts`, `extension/src/core/service/service.ts` (`prepareKeys`, `addAccountsFrom`),
  `extension/src/core/service/sync-flows.ts`, `extension/src/options/sync/gateway.ts` (`sk_prejoin`)
- `api/openapi.yaml` (`B64Bytes48`, `PasswordWrap`, `RecoveryWrap`)
- `docs/SYNC-DESIGN.md` §1.2, §1.3, §2.1–§2.3, §2.6, §3.1–§3.3, §3.9, §3.10, §3.13, I9, I11, revision 27
- `docs/security/local-vault.md`
- `docs/design/proposals/QUICK-UNLOCK.md` §0.2, §0A, §1.5, §2, §5.1, §5.2; `YUBIKEY-DESIGN.md`;
  `RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md` §0.3, §1.7; `PQ-READINESS.md` §1
- `LICENSE.md` (the licence of each path)

**SLIP-39 and Shamir sharing:**

- SLIP-39 specification: https://github.com/satoshilabs/slips/blob/master/slip-0039.md [verified]
- The `satoshilabs/slips` repository licence (CC-BY-SA-4.0): https://api.github.com/repos/satoshilabs/slips [verified]
- Reference implementation: https://github.com/trezor/python-shamir-mnemonic (`README.rst`, `LICENSE`,
  `shamir_mnemonic/shamir.py`, `shamir_mnemonic/constants.py`); https://pypi.org/project/shamir-mnemonic/ [verified]
- Trezor Multi-share Backup: https://trezor.io/learn/a/introducing-multi-share-backup [transcribed, vendor]
- Privy `shamir-secret-sharing`: https://www.npmjs.com/package/shamir-secret-sharing ;
  https://unpkg.com/shamir-secret-sharing@0.0.4/README.md [verified]. Audits: https://cure53.de/audit-report_privy-sss-library.pdf ;
  https://github.com/Zellic/publications/blob/master/Privy_Shamir_Secret_Sharing_-_Zellic_Audit_Report.pdf [not read].
  Blog: https://privy.io/blog/shamir-secret-sharing-deep-dive ; https://privy.io/blog/zero-leading-coefficients-cryptography
  [transcribed: search summaries; the second returned an error when fetched]
- `slip39`: https://www.npmjs.com/package/slip39 (https://github.com/ilap/slip39-js) [verified: npm metadata, README]
- `secrets.js-grempe`: https://www.npmjs.com/package/secrets.js-grempe [verified: npm metadata]

**Emergency access and inheritance:**

- Bitwarden help: https://bitwarden.com/help/emergency-access/ [verified]
- Bitwarden security whitepaper: https://bitwarden.com/help/bitwarden-security-white-paper/ [verified]
- Bitwarden server: https://github.com/bitwarden/server/blob/main/src/Core/Auth/UserFeatures/EmergencyAccess/EmergencyAccessService.cs
  (`KeyEncrypted`, `HandleTimedOutRequestsAsync`) [verified]
- Bitwarden clients (wait-time options):
  https://github.com/bitwarden/clients/blob/main/apps/web/src/app/auth/settings/emergency-access/emergency-access-add-edit.component.ts
  [verified]
- Proton: https://proton.me/blog/emergency-access [transcribed, vendor]
- 1Password community:
  https://www.1password.community/1password-at-home-31/feature-request-1password-access-after-death-legacy-contacts-1114
  [transcribed]
- Apple Legacy Contact: https://support.apple.com/en-us/102631 [verified]
- Google Inactive Account Manager: https://support.google.com/accounts/answer/3036546 [verified];
  https://security.googleblog.com/2021/10/google-protects-your-accounts-even-when.html [transcribed: search summary]

**WebAuthn:**

- Web Authentication Level 3, W3C Recommendation, 25 August 2026, §10.1.4 (`prf`): https://www.w3.org/TR/webauthn-3/
  [verified]

**Law** [transcribed]:

- RUFADAA: https://www.illinoislawyernow.com/2017/02/new-illinois-laws-for-2017-part-1-fiduciary-access-to-digital-assets/ ;
  https://finneylawfirm.com/estate-planning-digital-assets/ ; https://www.wealthmanagement.com/estate-planning/the-digital-afterlife
- BGH III ZR 183/17: https://www.lexblog.com/2018/07/12/german-federal-supreme-court-facebook-account-passes-to-heirs/ ;
  https://www.hiig.de/en/is-there-digital-life-after-death/
- PIPL Article 49: https://www.secrss.com/articles/94168 ; https://www.chinalawtranslate.com/pipl/ (the fetch was
  refused)
