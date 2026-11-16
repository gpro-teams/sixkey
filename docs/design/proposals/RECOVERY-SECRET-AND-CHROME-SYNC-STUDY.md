# Recovery secret, word phrases and Chrome-account storage: feasibility study

> **Study, not a design and not implemented.** Nothing in `extension/`, `api/` or `contract/` changes because of this
> document. It answers an owner idea with evidence and recommends what to do. It has not been reviewed independently.

Date: 2026-10-20. Author: design study (Opus 5.5) at the owner's request.

**Markers**, as in `QUICK-UNLOCK.md`:

- **[verified]**: I read the primary source. That means this repository's code or docs, an official vendor document, or vendor source code on GitHub `main`.
- **[transcribed]**: taken from a news report, a secondary write-up, or a vendor page I fetched but did not test. Vendor claims stay vendor claims.
- **[inferred]**: my own reasoning.
- **[estimate]**: a number nobody measured.
- **[unverified]**: a claim I could not check.

Every [unverified] claim is collected in §5.

---

## 0. Summary and recommendation (read this first)

### 0.1 What the owner asked (translated)

> Switch to a private key plus a word phrase. We are not a wallet, so we don't need 12 words. For example, a 4-word phrase
> plus a private key shown once (or a password) would be friendlier. TOTP storage should follow the Chrome account, as
> MetaMask's does. A user then signs in to their Chrome account, sets a password, and unlocks with a PIN. Make our
> storage work like a crypto wallet's, but protect it against reverse engineering and cracking, because many hardware
> wallets were broken this year.

### 0.2 Short answers

| Question | Answer |
|---|---|
| Is 4 words enough for the **master password**? | **4 words from the EFF list (7,776 words): yes, as the minimum.** That is 51.7 bits, just above the 50-bit floor the project already uses; PLAN already accepts "≥ 4 random words". **4 words from a 2,048-word list (BIP39): no.** That is 44 bits. The generated default should be **5 EFF words** (64.6 bits). §1.5 |
| Is 4 words enough as the **only** secret? | **No.** One secret cannot be both memorised (short) and written down (it must then be 128 bits). Unlike a wallet phrase, a TOTP phrase restores nothing without a copy of the encrypted vault. §1.5 |
| Is 4 words enough as the **recovery** secret? | **No, and this is decisive.** The recovery wrap and the server's recovery verifier use fast hashes (HKDF, SHA-256). A full search of 4 words takes about 1 GPU-hour (BIP39) to 250 GPU-hours (EFF) on one rented GPU, from a profile copy or from a server dump. The recovery secret stays 128 bits. If words are wanted, the same 16 bytes can be **shown as words** (11 EFF words). That changes only the encoding. §1.5 |
| What does "4 words + private key shown once" map to? | **Almost exactly today's design.** The master password wraps the vault key with PBKDF2. A 128-bit recovery key, shown once, wraps it with HKDF. The owner's idea adds three changes: generated words as the default password (being built elsewhere), better names, and a new transport (Chrome sync). §1.6 |
| Naming | Keep "**Password**" in the UI, with "suggested: 5 random words". Rename "recovery code" to "**Recovery key**". Add a printable "**Emergency kit**". Avoid "**Secret phrase**": it is the wallet word for the recovery seed, and it is what phishers ask for. §1.7 |
| A 1Password-style second secret? | **Worth designing before sync goes live**, for synced material only. It makes a stolen server database (and Google-held ciphertext, if Chrome sync is ever built) useless for password guessing. It does nothing against a profile copy. Because Sixkey never lets a new device join with the password alone (D2), users would never have to type it. §1.8 |
| Can `chrome.storage.sync` carry the vault? | **Technically yes, within narrow limits.** Total quota is 100 KB, about 150 accounts and fewer as deleted-account records accumulate. It works only between copies of Google Chrome. It has no versioning or compare-and-swap, no history and no delivery receipt. It hands the password wrap to whoever controls the Google account, which bypasses D2. It needs no new permission. §2 |
| "Chrome account + password + PIN unlocks": what is that cryptographically? | The Chrome account only **moves** data and holds no key. The password is the **only** barrier against offline guessing. The PIN is a memory-only convenience after the password, as it already is today. §2.4 |
| "Work like a wallet, but resist cracking" | A wallet's storage **is** a password-encrypted local vault, the same as Sixkey's. Wallets were drained through **offline cracking of stolen vaults**, **malicious updates**, **weak random numbers** and **phishing**. In 2025 and 2026 the hardware-wallet losses came from **weak entropy (Coldcard) and supply-chain tampering (Ledger units from one reseller)**. The lab laser attacks caused no reported losses. For open-source code, "anti-reverse-engineering" can only mean cryptography and release integrity, never obscurity. The Chrome Web Store bans obfuscated code anyway. §3 |

### 0.3 Recommendation

**Do now (small, about 2 days of team work in total [estimate], plus one store-dashboard step):**

1. Keep the two roots: a password and a 128-bit recovery key.
   - Rename "recovery code" to "Recovery key" (恢复密钥) in the UI and docs, and add the emergency-kit wording (§4.1 item 1).
2. Pass this study's numbers to the passphrase-generator work, which is already in progress (§4.1 item 2):
   - default 5 EFF words, minimum 4;
   - a 2,048-word list needs at least 5 words;
   - draw only with `getRandomValues`, using rejection sampling;
   - accept a generated phrase on its computed entropy, not on the zxcvbn estimate.
3. Test the two recovery-key text inputs for the "Demonic" session-restore leak (CVE-2022-32969) and fix them (§4.1 item 3):
   - `options/Reset.tsx:141` and `options/sync/widgets.tsx:140`, both `type="text"`.
4. At the first store submission, turn on the Chrome Web Store's **Verified CRX uploads** (§4.1 item 4).

**Design next:**

5. A device-held **account key** (two-secret derivation) for the synced key bundle, decided before sync goes live: about 2 to 3 weeks plus review [estimate]; owner question 2.
6. Optionally, the recovery key shown as 11 EFF words, with the parser accepting both forms forever: 3 to 5 days [estimate].
7. QUICK-UNLOCK Stage 2 (a hardware-bound key through WebAuthn PRF), already planned. After it, an optional "this computer's sign-in is required" mode.

**Drop:**

- any recovery secret shorter than 128 bits;
- a 4-word phrase as the only secret;
- the Chrome account as an unlock factor;
- a PIN stored on disk;
- lockout or self-destruct after wrong master passwords;
- obfuscation or anti-debugging code;
- a recovery key in BIP39 format;
- wallet-style key derivation from a phrase;
- raising PBKDF2 iterations as the main defence.

**Chrome-account sync:** do not build it now. It is an owner decision (§2.9, question 1).

### 0.4 Owner questions

1. **Chrome-account sync.** Choose one:
   - (a) never;
   - (b) a free, Chrome-only "basic" sync next to the paid cloud, where the cloud adds other browsers, 30-day history, a device list with revocation, large vaults and later teams;
   - (c) **not now; revisit after the hosted cloud launches, with real demand data (recommended)**.

   A free Chrome sync would cover the most common case: one person, Chrome on two or three computers, fewer than about 150 accounts. That is most of the paid tier's natural market.
2. **The account key** (two-secret derivation) **for synced data, before sync goes live** (about +2 to 3 weeks)?
   - **Gain:** a stolen server database cannot be used to guess even a weak password.
   - **Cost:** the deferred option "join a new device with email + password" (SYNC-DESIGN §12 Q2(b)) would also need the account key, typed from the emergency kit, as 1Password does.
   - **Recommended: yes.**

---

## 1. Words, bits and what an attacker pays (Q1)

### 1.1 Bits per word

A word drawn uniformly at random from a list of N words adds log₂ N bits. A word the user picks adds far less, so all of
this assumes **generated** phrases.

| Target | BIP39 English (2,048 words, 11 bits each) | EFF large list (7,776 words, 12.925 bits each) | Crockford base32 (5 bits/char, today's recovery key alphabet) |
|---|---|---|---|
| ≥ 50 bits | 5 words (55) | **4 words (51.7)** | 10 chars |
| ≥ 64 bits | 6 words (66) | **5 words (64.6)** | 13 chars |
| ≥ 80 bits | 8 words (88); 7 give 77 | 7 words (90.5); 6 give 77.5 | 16 chars |
| ≥ 128 bits | **12 words** (BIP39: 128 random bits + 4 check bits) | 10 words (129.2); **11 words** leave about 14 bits for a typo check | 26 chars; **today: 28 chars = 128 + 12 check bits** |

Sources:

- BIP39's table: 128 bits of entropy plus 4 checksum bits make 12 words. BIP39 is MIT-licensed [verified, bitcoin/bips].
- EFF: 6 words are "about 2⁷⁷" alternatives, and EFF recommends "a minimum of six words" [verified, eff.org/dice].
- Today's code: `recovery-code.ts`, 128 random bits plus 12 check bits in 28 symbols [verified].

**12 words is not a wallet convention.** It is what 128 bits cost with a 2,048-word list. You cannot get 128 bits from 4
words: that would need a list of 2³² words. "4 words" and "128 bits" are two different secrets.

### 1.2 What a guess costs: measured GPU numbers

The browser has no memory-hard KDF:

- Argon2 is not in WebCrypto.
- The CSP forbids `wasm-unsafe-eval`.
- PLAN decided "no WASM Argon2" (docs/history/PLAN-zh.md, §5.1).

So a password costs exactly PBKDF2-HMAC-SHA256 (`kdf.ts`: floor 600,000, ceiling 20,000,000 [verified]).

- **Measured, RTX 5090, hashcat 6.2.6+:**
  - mode 10900 (PBKDF2-HMAC-SHA256, 999 iterations) runs at **11,157.2 kH/s**, which is **≈ 1.1 × 10¹⁰ PBKDF2 iterations per second**;
  - modes 10000 (Django, 9,999 iterations, 1,111 kH/s), 26600 (MetaMask, 9,999 iterations, 1,109 kH/s) and 23400 (Bitwarden, 99,999 iterations, 117 kH/s) give the same 1.1 to 1.17 × 10¹⁰;
  - mode 1400 (raw SHA-256) runs at 28.35 GH/s.

  [verified: Chick3nman's published 5090 benchmark gist.]
- **Guesses per second on one 5090:** about **18,600 at 600k**, 11,200 at 1M, 5,600 at 2M and **560 at 20M** [inferred
  from the line above].
- This is consistent with the repository's older figure of about 15,000/s on an RTX 4090 at 600k (PLAN §5.1). A 4090's
  SHA-256 rate is about 75% of a 5090's (21.2 GH/s, hashcat forum [verified]). It also fills the gap that
  `docs/research/security-incidents-report.md:86` left open ("no reliable PBKDF2-SHA256 data point").
- **Price:** an RTX 5090 rents for about **$0.20 to $1.00 per GPU-hour** on marketplaces in 2026, with a median around
  $0.64 [transcribed: beam.cloud, computeprices.com, gpus.io snapshots]. The tables use **$0.50**; scale linearly for
  other prices.
- **Fast hashes:** where a secret is protected only by HKDF or SHA-256, one guess costs about 6 to 8 SHA-256 compressions.
  That is roughly **4 × 10⁹ guesses per second** on one 5090 [estimate derived from mode 1400; no HKDF kernel was
  benchmarked].
- **ASICs:** Bitcoin miners compute double SHA-256 over a fixed 80-byte header with a nonce search. They cannot run
  PBKDF2-HMAC [inferred]. Custom PBKDF2 hardware is possible for a state-level attacker. I did not quantify it. Treat
  every dollar figure below as a floor for such an attacker, not a ceiling.

### 1.3 Expected cost to find the secret (half the space), one rented RTX 5090 at $0.50/h

| Secret (generated) | Bits | PBKDF2 600k (today) | 2M | 20M (code maximum) | Fast hash only (HKDF/SHA-256) |
|---|---|---|---|---|---|
| 4 BIP39 words | 44.0 | **≈ $66,000** | ≈ $220,000 | ≈ $2.2M | **≈ $0.30** (about 0.6 GPU-hour) |
| 50-bit floor (today's policy) | 50.0 | ≈ $4.2M | ≈ $14M | ≈ $140M | ≈ $20 |
| 4 EFF words | 51.7 | **≈ $14M** | ≈ $45M | ≈ $455M | **≈ $65** (about 130 GPU-hours) |
| 5 BIP39 words | 55.0 | ≈ $135M | ≈ $450M | ≈ $4.5B | ≈ $630 |
| 5 EFF words | 64.6 | **≈ $1 × 10¹¹** | ≈ $3.5 × 10¹¹ | ≈ $3.5 × 10¹² | ≈ $500,000 |
| 6 EFF words | 77.5 | ≈ $8 × 10¹⁴ | — | — | ≈ $4 × 10⁹ |
| 128-bit recovery key | 128 | — | — | — | ≈ $10²⁵ (not attackable) |

[estimate, computed from §1.2. "Expected" means half the space. Time scales with fleet size: 4 BIP39 words at 600k are
about 131,000 GPU-hours, or about 5.5 days on 1,000 rented GPUs.]

Rule of thumb: **every 2⁴⁰ guesses cost an attacker about $8,000 at 600k, about $27,000 at 2M and about $270,000 at
20M.** Each extra bit doubles it.

### 1.4 Iterations or words

- **Each doubling of PBKDF2 iterations buys about 1 bit. Each generated word buys 11 to 13 bits.** One extra EFF word is
  worth the same as raising iterations from 600k to about 4.6 billion.
- Iterations are paid on every unlock by the **slowest** supported machine:
  - 600k takes about 40 ms on an M3 Max and 0.4 to 1 s on a low-end machine (PLAN §5.1 [transcribed estimate]);
  - 20M would take 13 to 33 s on the low-end machine. That is a ceiling against a hostile server (its purpose in `kdf.ts`), not a default.
- A modest raise (up to about 2M, +1.7 bits) is defensible for local-only vaults, calibrated per machine at setup. It is
  not where security comes from.
- MetaMask's current default is 900,000 (`@metamask/browser-passworder` source [verified]). Our 600k floor is in the same
  range.

### 1.5 Is "4 words" enough?

**(a) As the master password: yes, as the minimum, from the EFF list.**

- 4 EFF words give 51.7 bits. That just clears the 50-bit floor that `local-vault.md` and the settings page enforced when this was written (since
  OWNER-DECISIONS/15, 2026-10-22, a warning for the master password, not a floor), and
  PLAN already accepts "≥ 4 random words" (docs/history/PLAN-zh.md:180 [verified]).
- Against the profile-copy attacker (A3) and a server dump (A1), it costs about $14M at 600k [estimate]. That is ample for
  a vault of second factors, where the attacker still needs each site's password.
- 4 BIP39 words (44 bits, about $66k) fall below the floor and should not be offered.
- **Recommended default for the generator: 5 EFF words** (64.6 bits). EFF itself recommends 6.
  - The PIN and device unlock (QUICK-UNLOCK) mean the phrase is typed rarely, so one more word costs little.
  - The concurrent generator work owns the final number (its notes, `docs/design/notes/PASSWORD-SETUP-NOTES.md`, did not
    exist when this was written). This study adds three inputs.
- **Input 1: never accept fewer than 4 EFF or 5 BIP39 words.**
- **Input 2: accept a generated phrase on its computed entropy, not on zxcvbn.**
  - zxcvbn ships the EFF list in its dictionaries (OWNER-DECISIONS/05 [verified]).
  - It will therefore score a real 4-word draw word by word, by dictionary rank, plausibly below 50 bits, and could reject
    a phrase that is in fact 51.7 bits [inferred, not tested].
- **Input 3: sampling.**
  - Draw only with `crypto.getRandomValues`. `bytes.ts` does so [verified], and `extension/src` has no `Math.random`
    [verified].
  - 7,776 is not a power of two, so use **rejection sampling**. A plain modulo would bias the draw.

**(b) As the only secret, with no recovery key: no.**

- **The two jobs collide.** A memorised secret must be short, so 4 or 5 words. A written-down secret is what gets stolen,
  photographed or stored in cloud notes, so it must be 128 bits: it has to resist fast-hash guessing forever, unrotated.
  One string cannot be both.
- **A wallet phrase is not a model here.** A wallet's phrase *regenerates* its keys because the blockchain holds the
  state. TOTP secrets are random values issued by each website. A phrase cannot regenerate them; it can only decrypt a
  stored copy. So "the phrase alone restores everything, anywhere" is impossible for TOTP: a copy of the ciphertext must
  exist somewhere (this profile, a backup file, a sync server).
- **No second root means no recovery.** Forgetting a sole secret loses everything. Sixkey keeps two roots precisely so
  that one can be lost.

**(c) As the recovery secret: no. This is decisive.**

- **The code uses a fast hash.** `keyring.ts` `setRecovery` wraps the vault key under **HKDF** of the recovery secret, not
  PBKDF2 [verified].
- **So does the server.** SYNC-DESIGN §2.2 stores `recovery_verifier = SHA-256("sixkey-recovery-verifier|1|" ‖
  HKDF(code))` [verified].
- That is safe only because the code has 128 bits. With 4 words, either the local wrap (from a profile copy) or the
  verifier (from a server dump) falls at fast-hash speed:
  - about 0.6 GPU-hour for 4 BIP39 words;
  - about 130 GPU-hours for 4 EFF words (§1.3).
- Moving the recovery wrap to PBKDF2 would make it no stronger than a 4-word password. Yet it is the secret most likely
  to be written down and copied.
  - The LastPass 2022 vault thefts are the precedent: offline cracking of stolen vaults found the crypto seeds users had
    stored in notes, with more than $35M taken from more than 150 victims (Krebs [transcribed]).
  - A 2025 US forfeiture complaint said a $150M theft "may have used private keys extracted by cracking the victim's
    password vault" [transcribed].
- **Keep 128 bits.** To make it friendlier, change only its **presentation**:
  - the same 16 bytes shown as 11 EFF words, with about 14 check bits;
  - the server, the key bundle and the contract are untouched;
  - the parser keeps accepting the 28-character form.

  Not as BIP39 words; see §1.7.

### 1.6 What the owner's scheme maps to today

| Owner's element | Today's element | Status |
|---|---|---|
| "4-word phrase" | Master password. It wraps the vault key (VK) with PBKDF2-SHA256 ≥ 600k (`keyring.ts` `setPassword`). Generated as random words by default | Exists; the generator default is in progress elsewhere |
| "Private key shown once" | Recovery key: 128 random bits, shown once and confirmed. It wraps the VK with HKDF (`setRecovery`) and also resets the password | Exists |
| "(or a password)" | A user-chosen master password (12-character floor; below 50 estimated bits a warning since OWNER-DECISIONS/15) | Exists |
| "PIN to unlock" | A session PIN, memory only. It ends at browser restart, after 12 h or after 5 wrong tries (QUICK-UNLOCK §5) | In implementation (`QUICK-PIN-NOTES.md`) |
| "Storage follows the Chrome account" | — | A new transport. §2 |
| "Log in to the Chrome account" | — | Not a key. §2.4 |

So the owner's scheme is today's design, plus generated words as the default, better names, and possibly a new transport.

### 1.7 Naming and structure

| Concept | Recommended UI name (en / zh) | Why |
|---|---|---|
| What you type to unlock | **Password** / 密码 (docs keep "master password"). Generated by default; the field says "Suggested: 5 random words" | One name whether the user generates it or chooses it. |
| The 128-bit secret shown once | **Recovery key** / 恢复密钥 (was "recovery code" / 恢复码) | In a TOTP app, "code" already means the 6-digit code. "Key" says what it is: something that opens everything. |
| One printable page | **Emergency kit** / 应急包 | It holds the recovery key, a blank line for the password, what the key opens, and "Sixkey asks for this only on its own restore screen". 1Password's kit has the same shape ("has space for you to write your account password" [transcribed]). |
| Convenience layers | PIN; "Unlock with this computer" (PRF) | As in QUICK-UNLOCK. They are never a root. |

**Avoid "Secret phrase".**

- MetaMask calls the wallet's recovery seed the "Secret Recovery Phrase" [verified, MetaMask support].
- A wallet user would read "secret phrase" as the thing to write down and type into restore screens, which is the
  opposite of our password.
- Phishing kits ask for "your secret phrase". The Trust Wallet incident's follow-up phishing site asked for the seed phrase
  [transcribed]. Sharing the term with wallets invites that confusion [inferred].

**Avoid BIP39 format for the recovery key.** A Sixkey key in BIP39 form would be a valid wallet mnemonic. Malware hunts
for exactly that:

- SparkCat (2025) scanned photo galleries with text recognition for recovery phrases, in apps on the App Store and Google
  Play [transcribed: Kaspersky via The Register];
- stealers look for wallet mnemonics in files [inferred].

The EFF list, or today's base32, does not look like a seed phrase.

### 1.8 A second secret held on devices (1Password-style): worth it?

**What 1Password does** [transcribed from its security design pages]:

- The Secret Key is 26 random characters from a 31-character set, "slightly more than 2¹²⁸" values.
- It is "stored on your device by your 1Password client" and printed in the Emergency Kit.
- It is mixed into key derivation, so that "even all the data held by AgileBits is insufficient to verify a correct guess
  at someone's account password".

**What it would protect, in our threat model** (SYNC-DESIGN §1.2):

| Attacker | Today | With an account key |
|---|---|---|
| A3: profile copy (vendor sync, a clone, a stolen disk) | Offline guessing of the password wrap | **No change.** The key is in the profile. 1Password lists "locally exposed Secret Keys" as its own limit. |
| A1: stolen server database or a hostile server | Offline guessing of the password wrap **and** of `password_verifier` (`pw_auth`, PBKDF2-derived, §3.14) | **Nothing to guess**, provided **every** server-side password oracle mixes in the key: the bundle's password wrap and the `pw_auth` verifier. |
| Google holds the ciphertext (only if Chrome sync is built, §2) | Offline guessing by Google or by whoever controls the Google account | **Nothing to guess**, provided the key never goes into `storage.sync`. |

**Why it is cheap for Sixkey.** D2 already forbids joining a new device with email plus password alone. A new device
joins by SAS approval or with the recovery key (SYNC-DESIGN §3.2 and §3.3). So:

- with approval, the account key travels inside the encrypted enrolment payload P;
- with the recovery key, the device opens the VK and then reads the account key, which the key bundle stores encrypted
  under the VK;
- users never type it, unlike 1Password's users. It stays in the emergency kit only as a spare.

**What it costs** [estimate: M, about 2 to 3 weeks plus independent review]:

- **Format changes:**
  - a new keyring wrap/KDF descriptor;
  - an encrypted account-key field in the key bundle, covered by its MAC;
  - `pw_auth` derived with the key;
  - the contract vectors and the Python reference updated;
  - the server's shape checks updated.
- **Local storage:** the key is stored next to every local keyring copy (both slots, the keyring copy, the mirror).
  It **must** also be stored in the IndexedDB identity record (`sixkey-identity`). The cloud-restore path of SYNC-DESIGN
  §2.5 (identity present, `storage.local` lost, §4.13) opens the server's bundle with the password, so it needs the key
  from there. Wherever the key is missing, the password no longer opens that keyring, and the user needs the recovery
  key.
- **Keyring identity:** SYNC-DESIGN uploads the local keyring byte for byte (§2.3, §3.1). The design must either apply the
  key to the local wrap as well, which is harmless locally, or give up that rule. That decision belongs to a SYNC-DESIGN
  revision, not to this study.
- **Owner-level consequence:** the deferred Q2(b), "join with email plus master password", would then need the account
  key as well (1Password's model). Hence owner question 2.

**Alternative without it:** require a generated phrase of at least 5 EFF words for everyone who turns on sync. It is
simpler, but it forces the UX, and a user-chosen password remains fully exposed to A1.

**Verdict:**

- It is worth it for synced material. It is the one change that removes "confidentiality ultimately depends on password
  strength" from A1's row in SYNC-DESIGN §1.2.
- It must be decided **before sync goes live**. Before then it is a format change. After it, it would be a migration of
  every bundle.

---

## 2. "Storage follows the Chrome account": `chrome.storage.sync` as a transport (Q2)

### 2.1 What `storage.sync` is

From the official API reference [verified, developer.chrome.com/docs/extensions/reference/api/storage]:

- **Behaviour:**
  - "Items in the `sync` storage area are synced using Chrome Sync."
  - With syncing enabled, "the data syncs with every Chrome browser that the user is logged into".
  - "If disabled, it behaves like `storage.local`."
  - Offline, Chrome "stores the data locally … and resumes syncing when it's back online".
- **Quotas:**
  - `QUOTA_BYTES` 102,400 in total;
  - `QUOTA_BYTES_PER_ITEM` 8,192 (key plus JSON value);
  - `MAX_ITEMS` 512;
  - `MAX_WRITE_OPERATIONS_PER_MINUTE` 120 and `…_PER_HOUR` 1,800, where each `set`, `remove` or `clear` call counts as one;
  - the sustained-rate quota no longer exists.
- **Over a quota:** writes "fail immediately and set `runtime.lastError` … or when a Promise is rejected". So a write over
  the quota fails loudly, not silently.
- **Not documented:** encryption and conflict resolution. For sensitive data the page says "instead use
  `storage.session`".
- **Permission:** it needs only `storage`, which Sixkey already has. **No new permission and no host permission.** That is
  a real advantage over any server [inferred from the manifest in `local-vault.md` § Permissions].

### 2.2 Will a vault fit?

| Item | Size |
|---|---|
| Plaintext vault | 100 accounts ≈ 40 KB (SYNC-DESIGN §4.1 [verified doc]) |
| Upload padding | to a multiple of 16 KiB (§4.1): 40 KB becomes 48 KiB |
| Ciphertext in JSON | base64, so ×4/3: 48 KiB becomes about 64 KiB |
| Key bundle | about 1 KB, up to about 10 KB with 64 previous keys [estimate] |
| Room in `storage.sync` | 100 KB in total, in at most 8 KB items, so about 12 to 13 chunks |

[estimate]

- **Capacity: about 150 accounts.** Deleted accounts never shrink it, because tombstones are kept forever (§12 Q9).
- Native `CompressionStream` (no WASM) might roughly double that [estimate, untested]. The TOTP secrets themselves are random.
- Sixkey's own server limit is 8 MiB and up to 5,000 accounts, which is 80 times more.
- A user with "hundreds of accounts" sits at or over the limit.

**Layout problems** [inferred]:

- **Per-device slots** (each device writes only its own items, and readers merge all slots) avoid every write conflict,
  because the merge is commutative. But they divide the 100 KB by the number of devices: with three devices, about 50
  accounts each. Not viable.
- **One shared, chunked vault** fits, but it needs care:
  - Chrome syncs each item as its own entity, so another device can see a mix of old and new chunks.
  - So it needs a manifest naming a version and each chunk's hash, and readers that never apply a torn set.
  - Two devices writing at once resolve per item, presumably last-writer-wins [unverified]. The losing device keeps its
    local copy and must merge and write again.

### 2.3 Where it works

| Browser | Does `storage.sync` reach other devices? | Evidence |
|---|---|---|
| Google Chrome, signed in, sync on | Yes, between Chromes on the same Google account | [verified docs] |
| Google Chrome, signed out or sync off | No: it behaves like `storage.local` | [verified docs] |
| Google Chrome, signed in **without** full sync (the newer sign-in model) | Unclear. Chromium has a separate "extensions in transport mode" check, so it may depend on a per-type setting | [transcribed: Chromium `extension_sync_util.h`; behaviour unverified] |
| Microsoft Edge | Edge has its own sync (Microsoft account) and syncs installed extensions. Whether `storage.sync` data travels is not documented | [unverified] |
| Brave | Brave Sync (its own sync chain) lists an "Extension settings" type in `brave://sync-internals` (user reports) | [transcribed: forum; unverified] |
| Vivaldi | A user report shows "Extension Settings" entries in `vivaldi://sync-internals` | [transcribed: forum 2017; unverified] |
| Chromium, ungoogled-chromium, other forks without Google keys | No Google sync since 15 March 2021, when Google cut third-party Chromium builds off its private sync API | [transcribed: Chromium blog via BleepingComputer, ghacks] |
| Fingerprint browsers (AdsPower, GoLogin and the like) | Normally no Google sync. The vendor copies the whole profile instead, which is attacker A3 | [inferred; see `fingerprint-browser-security-lessons.md`] |
| Across vendors (Chrome ↔ Edge ↔ Brave) | **Never**: each vendor has its own backend | [inferred, high confidence] |

So "follows the Chrome account" means **Chrome to Chrome only**. A Brave or Edge user, or a Chrome user who is not signed
in, gets nothing, and the extension cannot reliably tell them so (§2.6).

### 2.4 The Chrome account is not a secret

- **An identity, not an authenticator.**
  - Being signed in gives the extension nothing secret.
  - `chrome.identity.getProfileUserInfo` returns an email and an ID, and would need the `identity` and `identity.email`
    permissions.
  - `getAuthToken` returns a short-lived OAuth bearer token, which is not a stable secret and cannot derive a key.
  - The Google account cannot decrypt anything [inferred from the API surface].
- **What "sign in to Chrome + password + PIN unlocks" means in cryptographic terms:**
  1. The Chrome account is the **transport and availability** layer. It delivers the ciphertext and the key bundle,
     **including the PBKDF2 password wrap**, to every Chrome signed into that account.
  2. **The password is the only key material.** PBKDF2 derives the KEK, which unwraps the vault key, which decrypts the
     vault. It is the only barrier against offline guessing by Google, by anyone who controls the Google account, and by
     any copy of a signed-in profile.
  3. The **PIN** is a memory-only convenience after the password, exactly as QUICK-UNLOCK Stage 1 already builds it. It
     adds no protection against any of those attackers (QUICK-UNLOCK §0.3, §1.7).
- **The one honest way to make the Google account hold a key.** A Google Password Manager passkey with PRF wraps the
  vault key.
  - That is QUICK-UNLOCK's synced-passkey option, decided as opt-in, off by default (§0.5 Q2).
  - Google says the GPM PIN protects passkey encryption so that Google cannot read the passkeys [transcribed:
    blog.google 2024-09]. Whether hardware limits guesses at that PIN is [unverified].
  - In August 2026 Unit 42's "Pass-ta-key" research showed that malware already running on a Windows PC can extract the
    Security Domain Secret, which decrypts all synced passkeys. Google reportedly provides no way to rotate it
    [transcribed: BleepingComputer]. A PRF secret held in such a passkey would be exposed the same way [inferred].
  - This confirms the decision to keep it off by default.

### 2.5 Privacy

- **What Google holds:** the ciphertext, plus account-linked metadata: that this Google account uses Sixkey, the item
  sizes, and when they were written.
- **Encryption on Google's side:**
  - With a Chrome custom sync passphrase, "Google can't read" the synced data [verified: Chrome Help 165139].
  - Without one, Chrome Help only says the data is protected by "industry-leading encryption".
- **Passphrase KDF:** in a Chromium source snapshot, new custom passphrases use scrypt (N = 2¹³, r = 8, p = 11) behind a
  feature flag, otherwise PBKDF2-HMAC-SHA1 with 1,003 iterations [transcribed: Chromium source snapshot; the current
  default is unverified]. Sixkey's content is end-to-end encrypted either way. The passphrase matters only for metadata
  such as item names, which Sixkey would keep opaque (`v0`, `v1`, …).
- **"Zero tracking":** Sixkey itself would still send nothing. Chrome would carry the data to Google. So it must be
  **opt-in, off by default**, disclosed in `docs/PRIVACY.md` and in the store's data disclosure, and nothing may be
  written to `storage.sync` before the user opts in. With extension sync on, Chrome uploads whatever is written there.

### 2.6 Failure modes and "never lose data"

| Event | What happens | Consequence |
|---|---|---|
| The vault outgrows the quota | `set()` rejects [verified] | Chrome sync stops for that vault. Sixkey must show "too large for Chrome sync" and never trim data to fit. |
| Extension sync is off for the account, or sync is paused (an auth error) | Data stays local. The API gives **no delivery receipt**. `chrome.identity` reportedly reports only full sync, not the per-type setting [transcribed blog] | Sixkey **cannot truthfully show "synced"**. `storage.sync` can never count as a backup; the backup reminder stays as it is. |
| The user resets sync or changes the Chrome passphrase | Google deletes the server copy and signs out every device. Chrome Help adds "your passwords and other info will be deleted from your Google Account **and your device**" [verified] | Whether each device's local `storage.sync` copy is wiped is [unverified]. |
| Sixkey is uninstalled on one device | A developer blog says Chrome then deletes all of the extension's `storage.sync` data [transcribed]; whether that propagates to other devices is [unverified] | If it propagates, one uninstall empties the transport for every device. |
| The Google account is locked or deleted | The transport is gone | Local copies are intact. |
| A stolen or shared signed-in device writes garbage | Accepted by Chrome; there is no write authorisation | Sixkey's acceptance rules (SYNC-DESIGN §4.3) keep local data safe. Any honest device can rebuild the transport copy. |
| Two devices change the password at once | No compare-and-swap on the key bundle: one version wins per item [unverified] | Not data loss (each device keeps its local wrap), but a password typed on one device may not work on the other until the user notices. |

**Rule, if it is ever built:** `storage.sync` is a transport only. The local store (two slots, snapshots, mirror) stays
the store of record. No device ever deletes or rewrites local data because `storage.sync` is empty, smaller or older.

### 2.7 Threat comparison with Sixkey's own end-to-end encrypted server

| Property | Sixkey server (SYNC-DESIGN rev 26) | `chrome.storage.sync` |
|---|---|---|
| Who stores the ciphertext | Sixkey's backend | Google |
| Who gets the guessable password wrap | Only the server operator, or a database thief (A1). **An email-only attacker gets nothing (D2)** | Google, **anyone who controls the Google account**, and any signed-in profile copy. **This bypasses D2** |
| New-device authorisation | SAS approval by an enrolled device, or the recovery key | Google sign-in, after which the password (or the recovery key) opens it |
| Device list and revocation | Yes, with signed requests | No. Only key rotation plus a new password shuts a device out (as A4) |
| Write authorisation | Device signature plus a write proof derived from the VK | Any signed-in Chrome |
| Concurrency | `if_version` / `if_kver` compare-and-swap | None; per-item resolution [unverified] |
| Rollback detection | Server version and head hash | Only what Sixkey adds in its own manifest |
| History | 30 days | None |
| Size | 8 MiB, 5,000 accounts | 100 KB, about 150 accounts |
| Delivery confirmation | HTTP 200 | None |
| Permissions | One optional host permission | None new |
| Browsers | Any Chromium browser (and later others) | Chrome to Chrome only |
| Cost to the user | Paid, or self-hosted | Free |

With the account key of §1.8, the second row becomes "nothing to guess" in both columns. That is why the account key is a
prerequisite for Chrome sync.

### 2.8 How it would fit the existing sync engine

- **What can be reused** [inferred from SYNC-DESIGN §2–§4]:
  - The `EncryptedVault` v1 envelope, the key bundle and its MAC carry over unchanged. They do not depend on the transport.
  - The merge is commutative and idempotent, so it converges without compare-and-swap, as long as every device keeps its
    local copy.
  - `core/sync` already takes its transport, clock and storage as injected dependencies (§4).
  - The key adoption rules R1–R3 and vault-key pinning (§3.9) still apply.
- **What changes:**
  - a new transport adapter (chunks, a manifest with version and hashes, torn-set handling);
  - "status" emulated from the manifest;
  - no write proof, no device signing key, no enrolment state machine and no SAS;
  - no `pw_auth`, no history and no revocation;
  - a new "join" path: on first run, find a vault in `storage.sync` and open it with the password or recovery key. The
    §3.5 rules for merging local data apply.
- **Who authorises a new device:** Google sign-in, plus knowledge of the password or the recovery key. With the account
  key, it would be the recovery key, or an approval relayed through `storage.sync` itself. That relay is possible but
  heavy.
- **Effort:** L, about 4 to 6 weeks plus an independent review, after the account key [estimate].

### 2.9 Product and monetisation: an owner-level question

**The commercial fact.** The paid tier is "hosted cloud sync only", and features must never be gated locally. A free
Chrome-account transport is not a local gate: Google provides it, so offering it violates no stated principle. But it
covers the most common user: one person, Chrome on two or three computers, fewer than about 150 accounts. Many of them
would then never need the paid tier [inferred].

| Option | For | Against |
|---|---|---|
| **(a) No Chrome sync** | The clearest monetisation. One sync protocol to audit. No D2 bypass to explain | Competitors offer free Chrome sync. Authenticator.cc, about 9 million users, stores entries in Chrome sync, in plaintext when no password is set (`fingerprint-browser-security-lessons.md` [transcribed there]). Users may expect "it follows my Chrome" |
| **(b) Free "basic" Chrome sync plus the paid cloud** | Goodwill and open-source ethos. The cloud's value is clear: other browsers, history, devices and revocation, large vaults, later teams and mobile | A second protocol to audit. Weaker guarantees to explain. The 100 KB ceiling surfaces as "sync stopped". It cannibalises the paid tier before its value is known |
| **(c) Not now; revisit after the cloud launches (recommended)** | Keeps the format ready (§2.8) at no cost. Lets the account key land first. Decides on real data | Delays a feature some users expect |

Self-hosting (`OWNER-DECISIONS/08`) already gives technical users free sync whichever option is chosen.

---

## 3. Wallet-style storage and "anti-cracking" (Q3)

### 3.1 What the wallet model really is

- **MetaMask's vault:**
  - It is kept in the extension's **local** storage, not in `storage.sync`. `shared/lib/stores/extension-store.ts` on
    `main` uses `browser.storage.local` [verified]. `main` also has an IndexedDB storage adapter, so the exact store the
    vault lives in today is not pinned down [unverified]. Either way it is local to the profile.
  - It is encrypted with AES-GCM under PBKDF2-SHA256 of the password: **900,000** iterations by default, while old vaults
    used 10,000 and are re-encrypted on unlock (`updateVault`) (`@metamask/browser-passworder` `src/index.ts` [verified]).
  - It holds the Secret Recovery Phrase (12 BIP39 words, 128 bits) and imported keys.
  - **The password is local only.** It recovers nothing.
- **Recovery is the phrase.** It regenerates the keys, because the blockchain holds the balances.
- **Social login (2025):**
  - The phrase is stored encrypted in MetaMask's backend, and the key is split by Shamir secret sharing among share
    holders.
  - Google, Apple or Telegram login only gives access to the shares.
  - "the key share holders employ a rate limiting mechanism to limit the number of password guessing attempts".
  - "The only instance where a full SRP exists is on your device".

  [verified: MetaMask support page]
- **So:** MetaMask does **not** keep the vault "in the Chrome account". Its storage is local. The account-based variant is
  a server-side, rate-limited backup. The repository's earlier UX study reached the same conclusion (`ux-study.md` §2.5).

### 3.2 Why the model maps imperfectly to TOTP

- **Nothing to derive.** A wallet derives everything from one seed. TOTP secrets are random values issued by each site.
  So "wallet-style storage" for Sixkey is a password-encrypted local vault plus a 128-bit recovery secret, **which is what
  Sixkey already is**.
- **The missing feature is impossible.** The only wallet property Sixkey lacks, "the phrase alone restores on any
  machine", cannot exist without a ciphertext copy somewhere (§1.5 b).
- **What could be copied.** MetaMask's server-side guess limiting (its social login) could be copied only with a server.
  Sixkey's equivalent is the account key (§1.8): instead of limiting guesses, it leaves the server nothing to guess.

### 3.3 What attackers did to extension wallets

| Attack | Evidence | Relevance to Sixkey |
|---|---|---|
| **Offline guessing of stolen vaults** | MetaMask vaults are a hashcat target. Modes 26600/26610 run at about 1.1M guesses/s on a 5090 at the legacy 10,000 iterations [verified benchmark]. Infostealers such as Lumma search for "browser extensions, and local keys associated with wallets like MetaMask" (Microsoft via secondary reporting [transcribed]). Seeds in LastPass vaults were cracked after the 2022 breach (§1.5 c) | The same as A3 (profile copy) and A1. The only defences are entropy and the KDF (§1.3), and the account key for server copies (§1.8) |
| **Secrets written to disk by the browser** ("Demonic", CVE-2022-32969) | Chromium and Firefox save non-password input fields in session-restore files. A seed typed into a `type="text"` field survived restarts and even uninstalls. MetaMask fixed it in 10.11.3 with one password-type field per word [transcribed: Halborn, GoPlus] | **Applies today.** Sixkey's recovery-code inputs are `type="text"` in a settings tab (`Reset.tsx:141`, `sync/widgets.tsx:140` [verified]). §4.1 item 3 |
| **A malicious update** | Trust Wallet extension 2.68.0, 24 Dec 2025: injected code disguised as analytics took seed phrases. At least $7M lost. How it was published is still being investigated [transcribed: BleepingComputer]. A leaked Chrome Web Store API key is claimed by one analysis [transcribed: Verichains; unverified] | The CSP does not help, because the update ships its own manifest and policy. What helps is release integrity: Verified CRX uploads, signed reproducible builds, store-account hardening |
| **Phishing for the recovery secret** | A lookalike "fix-trustwallet" site asked for the seed after that incident [transcribed] | Naming and copy (§1.7). The recovery key is never needed in normal use, and Sixkey asks for it only on its own restore screen |
| **Screenshot and text scanners** | SparkCat (2025) used text recognition on photo galleries to find recovery phrases [transcribed] | Don't make the recovery key look like a BIP39 seed. Recommend writing or printing it, not screenshots |

### 3.4 The 2025–2026 hardware-wallet breaks, and what they exploited

| When | Device | What was exploited | Funds lost? | Source |
|---|---|---|---|---|
| Mar 2025 | Trezor Safe 3 | **Voltage glitching** of the microcontroller to bypass the firmware-integrity check, so a tampered device can pass as genuine (a supply-chain path). The seed stays in the secure element | No reported loss | [transcribed: The Block, 13 Mar 2025; Cointelegraph] |
| Jun 2026 (disclosed 3 Jun) | Trezor Safe 7 (TROPIC01 chip) | **Laser fault injection** on a desoldered, decapsulated chip extracted "a subset of secrets protected by the chip". Trezor says the PIN and backup stay inaccessible. Not fixable by firmware | No | [transcribed: Trezor's own blog, vendor claim] |
| Jul 2026 (published 9 Jul) | Tangem cards | **Laser fault injection** skipped "a single conditional check" in `SetPin`, setting a new access code without the old one or a backup card. About a $250,000 lab, about 2 hours per card once characterised, visible damage, not patchable. "The master key never leaves the card", but the attacker can sign | No | [transcribed: Ledger Donjon's primary write-up] |
| Jul–Aug 2026 (theft from 30 Jul) | Coldcard | **Weak entropy.** A 2021 build-configuration error (firmware 4.0.1) made seed generation fall back to a weak software random-number generator, "as little as 40 bits" on older devices. Seeds were brute-forced with **no access to the device**. A firmware update cannot repair seeds already generated | **Yes: about $116–130M** | [transcribed: TRM Labs, TechCrunch; figures preliminary] |
| Sep–Oct 2026 | Ledger X devices (the source's wording) sold through one reseller | **Supply chain.** A hardware implant (STM32, eSIM, LTE module) captured the seed shown on screen during setup and sent it out. Ledger's Genuine Check cannot detect an added implant when the secure element is intact | **Yes: $86–102M reported** | [transcribed: BleepingComputer; loss figures secondary] |

**Pattern:** the lab-grade physical attacks (glitching, laser) caused no reported losses. The money was lost to **bad
randomness** and **supply-chain tampering**. This matches the extension-wallet record in §3.3.

### 3.5 What transfers to a browser extension

1. **Entropy is the first thing to get right** (Coldcard).
   - Every generated secret must come from `crypto.getRandomValues`: the vault key, the recovery key and passphrase words.
   - No fallback generator, and rejection sampling for non-power-of-two lists.
   - A CI check that no other source of randomness appears in the secret paths.
   - A unit test of the word sampler's distribution.
   - Today: `bytes.ts` uses `getRandomValues` and the source has no `Math.random` [verified].
2. **Release integrity matters more than anything inside the code** (Trust Wallet, Ledger's reseller units, and Ledger
   Connect Kit in 2023).
   - Verified CRX uploads: uploads not signed with the developer's own key are rejected, since May 2025 [transcribed:
     Chrome developer blog and store docs, read through a search summary].
   - Signed, reproducible builds (`OWNER-DECISIONS/07`).
   - No remote code, with the CSP and `check-dist` enforcing it [verified, `local-vault.md`].
   - Few dependencies, and no third-party cryptography.
   - The install-source banner (H4).
3. **A check is not a key** (Tangem). A single conditional guarding a reset was enough to break it.
   - In an extension, anyone who can run code (DevTools, the debugging port, a modified copy) skips every check.
   - Only cryptographic binding counts. This is QUICK-UNLOCK's rule: a gate may only guard a key that is not on disk.
4. **Guess limits need hardware.** A secure element enforces a PIN counter; JavaScript cannot.
   - Sixkey's only equivalent is a WebAuthn authenticator (TPM, Secure Enclave, security key) through PRF (QUICK-UNLOCK Stage 2).
   - Everything else must be strong enough offline.
5. **Fault injection and side channels do not transfer as such.** There is no secure element to attack. The browser
   equivalent is the offline attack on a profile copy, with unlimited attempts, for which §1.3 is the whole answer.
6. **The secret must not look like a seed** (phishing, SparkCat). See §1.7.

### 3.6 "Protect against reverse engineering": what it can and cannot mean

- **Sixkey is open source by design**, and the threat model assumes the attacker has the code (Kerckhoffs's principle).
- **Obfuscation is not an option.**
  - The Chrome Web Store has banned obfuscated code since 2018, while allowing minification [transcribed: Chrome Web
    Store code-readability policy, Google security blog 2018-10].
  - It would also defeat audit-grade review.
- **Anti-debugging or anti-tamper JavaScript gives a false sense of security.** It is bypassed by anyone with the profile
  files, DevTools or the debugging port, which are exactly the attackers that matter (A3, A10).
- So "resist cracking" can only mean **cryptography plus release integrity**.

### 3.7 Defences: what we have, can adopt, and cannot have

| Defence | Status |
|---|---|
| High-entropy secrets: a 128-bit recovery key and a generated passphrase default | Recovery key: **have**. Generator: **in progress** elsewhere; §1.5 gives the parameters |
| KDF floor checked when reading stored parameters (≥ 600k), so a tampered file cannot lower it | **Have** (`kdf.ts`) |
| Higher iterations | **Small value** (§1.4). Optional per-machine calibration up to about 2M for local-only vaults; not for synced bundles, which every device must open |
| No key at rest beside the data (H1) | **Have** for every vault made since H1 |
| Non-extractable CryptoKeys | **Have** for derived keys. This only stops JavaScript from exporting them; the raw VK bytes still exist in memory while unlocked |
| Memory-only sessions (`storage.session`, "lock every time") | **Have** |
| Hardware-bound key through WebAuthn PRF | **Planned** (QUICK-UNLOCK Stage 2) |
| Optional "this computer's sign-in required" mode: the local password wrap replaced by one needing both password and PRF, so a profile copy is useless without the authenticator | **Propose, later**, after Stage 2. Losing the authenticator then means using the recovery key. With sync, it only helps together with the account key |
| Account key for synced material (§1.8) | **Propose, design next** |
| Lockout only in Sixkey's own UI (5 PIN tries); no master-password lockout or self-destruct | **Have / decided** (SYNC-DESIGN §13, F23) |
| Integrity: no remote code, strict CSP, `check-dist`, install-source check | **Have** |
| Integrity: signed reproducible builds, Verified CRX uploads | **Owner/store steps**, pending (`OWNER-DECISIONS/07`; §4.1 item 4) |
| Recovery-key inputs not written to session restore | **Propose now** (§4.1 item 3) |

**What we cannot have:**

- **Make a short PIN, or any secret below about 50 bits, safe against a profile copy or a server dump.** No browser KDF
  closes a gap of 10⁹ (QUICK-UNLOCK §1.7).
- **Stop malware or a debugging-port client while Sixkey is unlocked**, or a keylogger when the password is typed.
  - PRF unlock reduces how often the password is typed. It does not change the unlocked case.
- **Detect a modified copy of the extension.** It can simply remove the check (H4's stated limit).
- **Make PBKDF2 memory-hard.** No Argon2 is available without WASM, and the CSP excludes WASM.
- **Rate-limit an offline attacker**, or erase old LevelDB bytes.
- **Hide how it works.**

### 3.8 Threat table

| # | Attacker | What they get | Today | The owner's idea as stated (4-word only, Chrome sync, PIN) | The recommended path | What remains |
|---|---|---|---|---|---|---|
| 1 | **Profile copy** (A3: vendor sync, a clone, a stolen disk) | Keyring with the password wrap, ciphertext, recovery wrap | As strong as the password the user chose (warned below 50 estimated bits since OWNER-DECISIONS/15; PBKDF2 2M for new wraps, 600k before) | With 4 BIP39 words, about $66k. **With a 4-word recovery secret, about $0.30** (fast hash) | Generated 5 EFF words (about $10¹¹). 128-bit recovery key. Later, the optional PRF-required mode | A weak user-chosen password that zxcvbn overrates |
| 2 | **Stolen server database or a hostile server** (A1) | Bundle (password and recovery wraps), `pw_auth` verifier | As strong as the password | Same as row 1. A 4-word recovery verifier falls in about an hour on one GPU | **Account key: nothing to guess** | Denial of service, freezing, metadata (SYNC-DESIGN A1, A5) |
| 3 | **Google, or whoever controls the Google account** (only if Chrome sync is built) | Ciphertext and bundle. No D2 barrier | n/a | As strong as the password, with no approval barrier | Account key: nothing to guess. Or don't build it | Metadata at Google |
| 4 | **Email-only attacker** (A2) | An account session | Nothing (D2) | n/a | Unchanged | Squatting (A2 residual) |
| 5 | **Malware or a debugging-port client while unlocked** (A10, T4) | Everything, including the typed password | Not defended | Not defended | Not defended. Shorten the unlocked window ("lock every time") | All of it |
| 6 | **Malware while locked** | The password at the next unlock (keylogger) | Not defended | Not defended | PRF unlock means the password is typed less often | Most of it |
| 7 | **Malicious update** (store-account or pipeline takeover) | Everything from users who unlock after the update | Pending store steps | Not addressed | Verified CRX uploads, signed reproducible builds, two-person release | Google-side or account-recovery compromise |
| 8 | **Weak randomness in our own code** | Predictable keys | `getRandomValues` only [verified] | A word generator not yet written | Rejection sampling, a CI check, a distribution test | A browser randomness bug (outside our control) |
| 9 | **Person at the unlocked or PIN-locked computer** (T1) | The UI | 5 PIN tries; master password for exports | Same | Same | A DevTools user cracks the PIN offline in seconds (T5, documented) |
| 10 | **Phishing for the recovery key** | The recovery key | Warning copy | "Secret phrase" naming makes it worse | "Recovery key" name, the emergency-kit wording, a non-BIP39 format | Users who type it anyway |
| 11 | **Browser writes the secret to disk** (Demonic) | The recovery key in session-restore files | `type="text"` inputs [verified] | Same | Test and fix (§4.1 item 3) | Whatever else the OS swap or hibernation file holds |
| 12 | **Physical attack on a secure element** (fault injection, laser) | n/a: an extension has no secure element | n/a | n/a | n/a | The authenticators' own hardware (TPM, Secure Enclave), for users of PRF unlock |
| 13 | **Compromised synced-passkey provider** ("Pass-ta-key" class) | A PRF secret from a synced passkey | n/a (not built) | n/a | Keep synced passkeys opt-in, off by default (decided) | Users who opt in |

---

## 4. Recommended path (Q4)

### 4.1 Now (small)

1. **Rename to "Recovery key"** (恢复密钥) in the en and zh UI copy, `local-vault.md` and the help text. Add the
   emergency-kit wording (§1.7).
   - No format change. The code names (`recovery`, `recovery-code.ts`) can stay.
   - Effort S, about 1 day [estimate].
2. **Hand the numbers to the generator work** (§1.5 a). No extra effort; it is a note to that work:
   - the default (5 EFF words) and the minimum (4 EFF / 5 BIP39 words);
   - accept on computed entropy;
   - rejection sampling;
   - a distribution test.
3. **Demonic check.** Effort S, about 0.5 to 1 day [estimate].
   - Type a recovery key into `Reset.tsx:141` and the sync recovery input (`sync/widgets.tsx:140`).
   - Kill Chrome without closing the tab.
   - Search the profile's `Sessions/` files for it.
   - If it is there, switch those inputs to `type="password"` with a show toggle, or one field per group. Add the check to
     `OWNER-DECISIONS/12` manual checks, since an automated test may not cover session restore.
4. **Verified CRX uploads** at the first store submission. This is an owner or store-dashboard step. It belongs with the
   signing decisions in `OWNER-DECISIONS/07`, and it closes the leaked-API-key or compromised-dashboard path behind the
   Trust Wallet case.

### 4.2 Design next

5. **Account key for synced material** (§1.8).
   - A SYNC-DESIGN revision: format, storage beside every keyring copy, the SAS payload, the recovery path, `pw_auth`,
     contract vectors and the Python reference.
   - Effort M, about 2 to 3 weeks plus independent review [estimate].
   - Decide before sync goes live (owner question 2).
6. **Recovery key shown as words** (optional): 11 EFF words carrying the same 128 bits plus about 14 check bits. The
   parser accepts both forms forever, and the server is untouched.
   - Effort S to M, 3 to 5 days [estimate].
   - Reuse the word list the generator ships.
7. **QUICK-UNLOCK Stage 2** (PRF device unlock), as planned.
   - Then, optionally, the "this computer's sign-in required" mode (§3.7). Effort M [estimate]. It needs its own design note.
8. **Chrome-sync transport**, only if the owner chooses (b).
   - Prerequisite: the account key.
   - Then a design note covering chunking and the manifest, the opt-in, the honest status line, and the PRIVACY.md and store
     disclosures.
   - Effort L, about 4 to 6 weeks plus review [estimate]. Measure first the [unverified] items in §5 that concern Chrome:
     reset, uninstall, transport mode.

### 4.3 Drop

| Drop | Why |
|---|---|
| A recovery secret below 128 bits (4 or 6 words) | It falls at fast-hash speed from a profile copy or a server dump (§1.5 c) |
| A 4-word phrase as the only secret | The two jobs collide; it restores nothing without ciphertext (§1.5 b) |
| The Chrome account as an unlock factor; the `identity` permission | It carries no key (§2.4); the permission buys nothing |
| A PIN or gate stored on disk | Already rejected (SYNC-DESIGN §13 F25; QUICK-UNLOCK §0.3) |
| Lockout or self-destruct after wrong master passwords | Already rejected (F23): useless against copies, and a denial-of-service button |
| Obfuscation, anti-debugging, "anti-reverse-engineering" code | Banned by the store, useless against the real attackers, and an obstacle to audit (§3.6) |
| A recovery key in BIP39 format | Confused with wallets, targeted by seed scanners (§1.7) |
| Wallet-style (BIP32-like) derivation from a phrase | Nothing to derive: TOTP secrets are issued by websites (§3.2) |
| Raising iterations toward 20M as the main defence | About 1 bit per doubling, at the cost of the slowest machine's unlock time (§1.4) |

### 4.4 Owner questions (exact wording)

1. **Chrome-account sync.** Should Sixkey offer free sync through the user's Chrome account?
   - (a) never;
   - (b) yes, as a free Chrome-only "basic" sync next to the paid cloud;
   - (c) not now: decide after the hosted cloud has launched (**recommended**).
2. **Account key before sync goes live.** Add a device-held account key so that a stolen sync database cannot be used to
   guess any password, even a weak one?
   - It costs about 2 to 3 weeks before go-live.
   - The deferred "join with email + password" option would then also need the account key from the emergency kit.
   - (**Recommended: yes.**)

Everything else here (names, word counts, input fixes, which designs to write) is a team decision under the existing
rules. If in doubt, ask Opus 5.5.

### 4.5 What this study does not change

- The QUICK-UNLOCK decisions (§0.5 Q1–Q3).
- SYNC-DESIGN's D2, F23 and F25.
- The H1 rule (no key beside the data).
- The 50-bit floor for user-chosen passwords (since changed by OWNER-DECISIONS/15, 2026-10-22: a warning, not a floor).
- The no-WASM rule.

---

## 5. Unverified claims

1. Whether `storage.sync` syncs for a Chrome user who is signed in **without** full sync (the transport-mode setting).
2. Whether Edge, Brave, Vivaldi or Opera carry `storage.sync` data between their own installs. The Brave and Vivaldi
   evidence is user reports only.
3. How `storage.sync` resolves conflicts (assumed last-writer-wins per item), and whether a multi-item `set()` can arrive
   torn on another device.
4. Whether uninstalling the extension on one device deletes its `storage.sync` data on every device. The source is a
   developer blog only.
5. Whether a Chrome sync reset or passphrase change wipes each device's local `storage.sync` copy.
6. Whether `chrome.identity` can report the per-type "extensions" sync setting. A blog says no.
7. Whether hardware limits guesses at the Google Password Manager PIN, and whether a GPM passkey's PRF output is
   identical on every device of the account.
8. That zxcvbn scores a random 4-word EFF draw below 50 bits (§1.5 a). Untested.
9. The HKDF guess rate (about 4 × 10⁹/s on a 5090), derived from the raw SHA-256 benchmark, not measured.
10. Whether `CompressionStream` roughly doubles the number of accounts that fit.
11. Whether Chrome's session restore covers a `chrome-extension://` settings tab the way it covers web pages (the
    Demonic check, §4.1 item 3).
12. Apple's use of the term "recovery key", cited in passing as common practice; not fetched.
13. The hardware-wallet loss figures (Coldcard, the Ledger reseller units) and the Trust Wallet publishing vector: news
    and analyst reports, still changing.
14. The current default KDF for Chrome custom sync passphrases (scrypt behind a feature flag in a source snapshot).
15. Whether MetaMask's vault now lives in `storage.local` or in its IndexedDB adapter. Both are local to the profile.

## 6. Sources

**This repository** [verified]:

- `extension/src/core/crypto/kdf.ts`, `keyring.ts`, `recovery-code.ts`, `vk.ts`, `pin.ts`, `bytes.ts`
- `extension/src/options/Reset.tsx:141`, `extension/src/options/sync/widgets.tsx:140`
- `docs/SYNC-DESIGN.md` §0.2, §1.2, §2.1–§2.3, §3.1–§3.3, §4.1, §4.3, §12, §13
- `docs/security/local-vault.md`
- `docs/design/proposals/QUICK-UNLOCK.md` §0.3, §0.5, §1.2, §1.7
- `docs/history/PLAN-zh.md:180`
- `docs/research/ux-study.md` §2.5, `fingerprint-browser-security-lessons.md`, `security-incidents-report.md`
- `OWNER-DECISIONS/05`, `/07`, `/08`

**Chrome and Chromium:**

- `chrome.storage` API reference (quotas, behaviour): https://developer.chrome.com/docs/extensions/reference/api/storage [verified]
- Chrome Help, sync passphrase: https://support.google.com/chrome/answer/165139 [verified]
- Verified CRX uploads: https://developer.chrome.com/blog/verified-uploads-cws and https://developer.chrome.com/docs/webstore/update [transcribed: search summary]
- Chrome Web Store code readability (no obfuscation): https://developer.chrome.com/docs/webstore/program-policies/code-readability ; https://security.googleblog.com/2018/10/trustworthy-chrome-extensions-by-default.html [transcribed]
- Third-party Chromium sync cut-off, March 2021: https://www.bleepingcomputer.com/news/google/google-to-kill-chrome-sync-feature-in-third-party-browsers ; https://www.ghacks.net/2021/01/16/sync-and-other-features-may-stop-working-in-some-chromium-browsers-in-march-2021 [transcribed]
- Chromium transport-mode extension sync check: https://gitcode.com/openharmony-tpc/chromium_src/blob/master/chrome/browser/extensions/sync/extension_sync_util.h [transcribed]
- Chromium custom-passphrase KDF: https://chromium.googlesource.com/chromium/src/+/695245c/components/sync/base/passphrase_enums.h [transcribed]
- Brave and Vivaldi user reports: https://community.brave.app/t/sync-not-syncing-extensions-and-extension-settings/313353 ; https://forum.vivaldi.net/topic/25712/sync-status-update [transcribed]
- Uninstall and `chrome.identity` claims: a developer write-up, https://habr.com/en/articles/993286 (artemmarchenko, "Feb 5", year not shown) [transcribed]

**GPU cost:**

- RTX 5090 hashcat benchmark: https://gist.github.com/Chick3nman/09bac0775e6393468c2925c1e1363d5c [verified]
- RTX 4090 hashcat benchmark: https://hashcat.net/forum/printthread.php?tid=11001 [verified]
- GPU rental prices: https://www.beam.cloud/blog/nvidia-rtx-5090-pricing ; https://computeprices.com/providers/runpod/gpus/rtx5090 ; https://gpus.io/en/gpus/rtx5090 [transcribed]

**Word lists:**

- BIP39: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki [verified]
- EFF dice: https://www.eff.org/dice [verified]

**MetaMask and 1Password:**

- MetaMask browser-passworder source: https://github.com/MetaMask/browser-passworder/blob/main/src/index.ts [verified]
- MetaMask extension store source: https://github.com/MetaMask/metamask-extension/blob/main/shared/lib/stores/extension-store.ts [verified]
- MetaMask social login: https://support.metamask.io/configure/wallet/social-login/ [verified]
- 1Password security design: https://agilebits.github.io/security-design/apsk.html [transcribed]

**Wallet incidents:**

- Demonic: https://halborn.com/disclosures/demonic-vulnerability/ ; https://blog.gopluslabs.io/vulnerabilities-cases/user-client/metamask-phrase-leakage [transcribed]
- LastPass-linked thefts: https://securityaffairs.com/175156/cyber-crime/feds-seized-23-million-in-crypto-stolen-using-keys-from-lastpass-breaches.html ; Krebs via https://en.wikipedia.org/wiki/2022_LastPass_data_breach [transcribed]
- Lumma: https://www.neowin.net/news/microsoft-over-394000-windows-pcs-infected-by-lumma-malware-affects-chrome-edge-firefox/ [transcribed]
- Trust Wallet: https://www.bleepingcomputer.com/news/security/trust-wallet-confirms-extension-hack-led-to-7-million-crypto-theft ; https://blog.verichains.io/p/trust-wallet-browser-extension-breach [transcribed]
- SparkCat: https://www.theregister.com/2025/02/07/infected_apps_google_apple_stores [transcribed]

**Hardware wallets:**

- Trezor Safe 3 (2025): https://www.theblock.co/post/346018/trezor-discloses-vulnerability-safe-3-crypto-wallet-rival-ledger [transcribed]
- Trezor Safe 7 / TROPIC01: https://trezor.io/blog/news/Trezor-response-TROPIC01-chip-disclosure-no-impact-to-your-funds [transcribed, vendor]
- Tangem laser attack: https://donjon.ledger.com/blog/bypassing-tangem-card-security-with-laser-attack/ [transcribed, primary]
- Coldcard entropy: https://www.trmlabs.com/resources/blog/the-largest-hardware-wallet-exploit-of-2026-inside-the-usd-116-million-coldcard-hack ; https://techcrunch.com/2026/08/04/hackers-steal-over-130-million-by-exploiting-bug-in-offline-hardware-wallets/ [transcribed]
- Ledger reseller implant: https://www.bleepingcomputer.com/news/security/ledger-confirms-hardware-wallet-spy-implant-behind-crypto-thefts/ [transcribed]

**Google Password Manager passkeys:**

- https://blog.google/technology/safety-security/google-password-manager-passkeys-update-september-2024/ [transcribed]
- Unit 42 "Pass-ta-key": https://www.bleepingcomputer.com/news/security/new-pass-ta-key-attacks-let-malware-hijack-google-synced-passkeys/ [transcribed]
