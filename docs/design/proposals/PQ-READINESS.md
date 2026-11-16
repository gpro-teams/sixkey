# PQ-READINESS: Sixkey against future quantum decryption

Status: **proposal**, 2026-10-19. It answers the owner's requirement: "we must also defend against future post-quantum
decryption".
- No code changed. `docs/SYNC-DESIGN.md` (revision 26) stays as it is until the owner approves a revision.
- Facts about third parties are marked:
  - **[verified]**: read at a primary or official source;
  - **[secondary]**: from secondary reports;
  - **[unverified]**: my reasoning, or not confirmed.

Sources are at the end.

## Summary and recommendation

**Sixkey's data at rest is already quantum-conservative.** The vault, the keyring, the key bundle, the backups and the
local copies are protected only by symmetric cryptography:
- AES-256-GCM;
- HKDF-SHA256 and HMAC-SHA256;
- PBKDF2-SHA256 from the master password;
- a 128-bit recovery key.

A quantum computer gives at most a square-root speed-up (Grover) against these. No public-key algorithm protects
anything stored.

**There is one real harvest-now-decrypt-later (HNDL) exposure: the approval join.**
- The approving device sends the new device the **vault key (VK)** inside a payload. The key that encrypts that payload
  comes from an ephemeral **ECDH P-256** exchange (§3.2).
- A server that records that one exchange (our zero-knowledge threat model assumes it may), and later has a quantum
  computer, recovers the ECDH secret. With it, it decrypts the payload and obtains the VK, and with the VK every
  vault version it ever stored, past and future, until the next key rotation.
- The 6-digit codes do not help: they stop an active man-in-the-middle, not a passive recorder.

**Recommendation (do it before the sync gate opens, about one week).** Replace the approval join's 6-digit
*confirmation code* (shown on the approving device, typed on the new device) with a **128-bit pairing code** in the
recovery-code format (28 characters, 7 groups of 4, with typo check bits). Mix it into the payload key:
`K = HKDF(Z ‖ S, salt = h, "sixkey/v2/enroll-key")`, where Z is the ECDH secret and S the pairing code.
- S never touches the network, so a recorded exchange is useless even to a quantum adversary.
- It also replaces the confirmation code's job: only the real approving device knows S, so only its payload decrypts.
- Nothing has shipped, so this protocol change is cheap now and costly later.
- The server API and the contract's request and response shapes do not change. Only the KDF label, the enrolment
  vectors and the UI change.

**Also, at no cost:**
- make sure the API's TLS terminator offers the hybrid key exchange X25519MLKEM768, which Chrome already uses;
- write down the crypto-agility rules (algorithm and version identifiers that already exist, and how a signature
  migration would work).

**Wait for the browser for:**
- post-quantum *signatures* (ML-DSA) for device request signing. ECDSA forgery needs a quantum computer at the moment of
  the attack, not a recording, so this can follow when WebCrypto ships ML-DSA in stable Chrome;
- a hybrid KEM for the join, if the longer code proves too costly.

**Owner-level questions** (§6):
1. Accept the 28-character pairing code in place of the 6-digit confirmation code?
2. Keep the recovery key at 128 bits?
3. Approve the marketing wording?

---

## 1. Inventory of every primitive, classified

The sources reviewed:
- `extension/src/core/crypto/` (`envelope.ts`, `kdf.ts`, `keyring.ts`, `vk.ts`, `recovery-code.ts`, `pin.ts`);
- `extension/src/core/sync/crypto/` (`enroll-crypto.ts`, `signature.ts`, `device-key.ts`, `subkeys.ts`, `write-proof.ts`,
  `auth-proofs.ts`, `device-backup.ts`, `device-name.ts`, `keybundle.ts`);
- `contract/`;
- SYNC-DESIGN rev 26 (§2.1–§2.5, §3.1–§3.3, §3.14, §5.2);
- `QUICK-UNLOCK.md`;
- `YUBIKEY-DESIGN.md`.

Classification:
- **HNDL** means a recording made today becomes readable once a cryptographically relevant quantum computer (CRQC) exists.
- **Real-time** means a CRQC helps only an attack carried out while it is running.

| Use | Primitive | Protects | Quantum effect | Class |
|---|---|---|---|---|
| Vault envelope (local slots, snapshots, mirror, server versions) | AES-256-GCM under VK (256-bit) | confidentiality and integrity of all accounts | Grover: ~128-bit security left | **safe** |
| Keyring: password wrap | PBKDF2-SHA256 (≥600k) → KEK → AES-GCM | VK at rest, on device and on server | the password's entropy is the limit, classically already; Grover gives no practical gain (below) | **safe** (the classical guessing residual is unchanged) |
| Keyring: recovery wrap | 128-bit code → HKDF → AES-GCM | VK | Grover: ~2^64 *sequential* quantum evaluations of HKDF+AES; impractical, and parallelising only gains √k | **safe** at NIST category-1 strength (§1.3) |
| Keyring: previous VKs | AES-GCM under HKDF(VK) | old keys | as AES-256 | **safe** |
| Device-key backup `sk_sync_cfg.enc`, `sk_prejoin`, orphan list, staged | AES-GCM under VK subkeys | DSK copy, kept vaults | as AES-256 | **safe** |
| Device names | AES-GCM under K_name(VK) | names | as AES-256 | **safe** |
| KeyBundle MAC, write proof | HMAC-SHA256 under VK subkeys | integrity | HMAC keeps ≥128-bit security | **safe** |
| `pw_auth` / `recAuth` and server verifiers | PBKDF2/HKDF, SHA-256 | proof of the password or code | one-way; quantum gives no inversion beyond Grover | **safe** (the fixed-value residual F14 is unchanged) |
| PIN (QUICK-UNLOCK; its record on disk since 2026-10-30, PIN-RESTART-NOTES.md §18) | PBKDF2 → AES-GCM | quick unlock, also after a restart | symmetric only: no public key for a quantum computer to break; a copy of the profile can already try every PIN classically (its small space is the limit, said where the PIN is set) | **safe** |
| SAS and confirmation codes | 6 digits from SHA-256(tag ‖ h) | detecting an active MITM | live-attack only; a quantum computer cannot change a commitment already sent (SHA-256 binding) | **safe** |
| **Approval join key agreement** (§3.2) | **ECDH P-256** (ephemeral) → HKDF → AES-GCM over payload P | **P contains the VK and the key bundle** | **Shor recovers Z from the recorded epk_A, epk_N → K → VK** | **HNDL: the one real exposure** |
| Recovery-code join (§3.3) | the recovery key unwraps the bundle locally; `recAuth` to the server | VK | no public key involved | **safe** |
| Device request signatures, fork `Sixkey-New-Sig` | ECDSA P-256 (non-extractable DSK) | authenticity of requests | Shor recovers the private key from the public key (the server stores it), so requests can be forged **once a CRQC runs**; nothing past becomes readable | **real-time forgery only** |
| WebAuthn PRF and gate (QUICK-UNLOCK stage 2) | authenticator-side HMAC (hmac-secret); assertions ECDSA/EdDSA; CTAP2 key agreement ECDH P-256 between browser and authenticator; phone "hybrid" transport ECDH over BLE and a tunnel | the PRF secret that unwraps `sk_prf` | vendor-controlled; see §2(e) | **note only** |
| YubiKey OATH (YUBIKEY-DESIGN) | HMAC-SHA1/256 TOTP on the key; Sixkey stores references only; local native messaging | codes | symmetric | **safe** |
| TLS to the API | the browser negotiates; Chrome 131+ offers X25519MLKEM768 [secondary] | transport (metadata: email, OTP, `pw_auth`, ciphertext) | HNDL on the hop if the server side offers only classical groups | **configuration item (M8)** |

### 1.1 What a quantum adversary can do with recordings

The worst case is the server itself: malicious or compromised, recording everything, and later holding a CRQC. That is
our zero-knowledge threat.

- **Recorded enrolment traffic** (`epk_A`, `epk_N`, the approve `payload`):
  - it solves ECDH, derives K, decrypts P and gets the VK;
  - then it decrypts every vault version it stored under that VK, including versions written after the join, until a
    rotation;
  - after a rotation, the new VK reaches other devices only through key bundles (symmetric) and further joins. So each
    *recorded join* exposes the VK current at that time, plus any VK it wraps in `previous`.
- **Recorded ciphertext** (envelopes, bundles, history): no gain beyond Grover against AES-256 and HKDF. The realistic
  attack stays classical: offline guessing of a weak master password against the password wrap (Q8, already documented).
- **Recorded signatures**: nothing to decrypt. With a CRQC it can compute the device private keys from the stored
  public keys and forge device-signed requests. Most sensitive ones also need `pw_auth`, and a vault write also needs the
  write proof, whose `K_write` is a VK subkey. So the damage is limited to what a device signature alone authorises, the
  same as A3's "copy of the signing key", and only while the attacker runs a CRQC.

### 1.2 Grover on passwords and codes

- **256-bit keys** (VK, every subkey): about 128 bits of quantum security remain. That is NIST's highest category and
  CNSA 2.0's choice. No change needed.
- **Master password**:
  - Grover would need the whole PBKDF2 chain (600,000 SHA-256 iterations) as one reversible quantum circuit per guess,
    run serially.
  - Classical GPU guessing against a weak password is far cheaper for the foreseeable future [unverified as a cost
    figure, consistent with NIST IR 8547's reasoning that symmetric primitives keep adequate strength].
  - The defence stays what it is: the password strength policy (zxcvbn) and the iteration count.
- **Recovery key, 128 bits**:
  - The quantum attack is about 2^64 sequential Grover steps, each a full HKDF + AES-GCM evaluation. Grover parallelises
    poorly: k machines give only √k.
  - This matches AES-128, which NIST keeps as category 1 for the post-quantum transition [secondary].
  - **Quantum-conservative minimum for user-held secrets that guard offline-attackable data: 128 bits.** That is what we
    have. 160 bits (8 more characters) would add margin, but no standard asks for it (owner question 2).
- **Generated secrets** (the recovery key, and the proposed pairing code): use 128 bits at minimum.

---

## 2. Exposures and proposed fixes, by value

### (a) The approval join: pairing code (recommended) or hybrid KEM

**Option A: a symmetric pairing code. Recommended.**
- **The change**:
  - At approve time, the approving device A draws `S = 128 random bits`. It encrypts P under
    `K = HKDF(IKM = Z ‖ S, salt = h, info = "sixkey/v2/enroll-key")` instead of `HKDF(Z, h, "sixkey/v1/enroll-key")`.
  - After the server accepts the approval, A shows S in the recovery-code format: Crockford base32, 7 groups of 4, 12
    check bits, with a different domain tag than the recovery key so the two cannot be confused.
  - The user types S on the new device N. N checks the check bits, derives K, and decrypts P (three tries, as for the
    confirmation code today).
- **The SAS stays** (6 digits, N → A). It is what protects A against an active server that replaces N's key.
- **The confirmation code (A → N) goes**:
  - its purpose, proving to N that the real A checked the SAS, is covered more strongly, because only the real A knows S
    and a server-made payload cannot decrypt;
  - MUST 5's "the confirmation code exists only after approve is accepted" becomes "S is shown only after approve is
    accepted";
  - N's "do not use the payload before the code matches" becomes "the payload cannot be opened without S".
- **What it protects**: confidentiality of the VK against any recording, quantum or not, because S never leaves the two
  screens. It needs no new primitive, library or browser feature. It is not exposed to future attacks on lattices.
- **UX cost**: the user types 28 characters instead of 6 digits on the new device. Copy and paste works between profiles
  on one machine (the antidetect-browser case); across machines it is typed, as the recovery-code join already is.
  Owner question 1.
- **Contract, openapi and vectors**:
  - **No openapi change**: the payload is already opaque ciphertext, and S is never sent.
  - The vectors' enrolment group changes: a new label `sixkey/v2/enroll-key`, new known-answer vectors with S, and the
    confirmation-code vectors removed.
  - The labels table (§2.2) gains a pairing-code domain tag.
  - The transcript prefix becomes `sixkey-enroll|2|`, so a v1 implementation cannot interoperate by accident.
  - `check_consistency.py`'s label check (H8) picks the change up.
- **Code impact**: M1's two enrolment state machines and their tests; M6's approval screens (show S with Copy; type S
  with the existing 7-group input).
- **Migration**: none. Nothing has shipped, so v1 is simply replaced.

**Option B: a hybrid KEM (X25519 or P-256 ECDH plus ML-KEM-768, for example X-Wing). Not now.**
- **WebCrypto**: ML-KEM and ML-DSA are not in stable Chrome.
  - A blink-dev "Intent to Experiment" dated **2026-06-17** proposes ML-KEM-768/1024, ML-DSA-44/65/87, X-Wing and
    ChaCha20-Poly1305: a DevTrial behind the flag `webcrypto-pqc` from **M150**, and an origin trial **M151–M154**
    [verified]. Shipping is not decided [verified: the TAG review is pending].
  - X25519 itself shipped in WebCrypto in **Chrome 133** [secondary]. Our minimum Chrome is 120, so even X25519 would
    need a fallback.
- **Pure JS**: `@noble/post-quantum`:
  - MIT licence [verified];
  - ML-KEM about 7 KB gzipped [verified, README];
  - X-Wing as `ml_kem768_x25519` [verified];
  - **not independently audited** (self-audited at 0.6.1) and **does not claim constant-time execution** [verified, README].
  - WASM is not an option (our CSP forbids it); noble's main path is pure JS [verified].
- **Cost**: a new dependency that fails our "audit-grade" bar today; new enrolment fields (encapsulation key of about
  1.2 KB, ciphertext of about 1.1 KB) in the contract, the server's size checks and the vectors; a larger settings-page
  chunk; about 1.5–2 weeks.
- **Gain over A**: a 6-digit code could stay. But its quantum safety would rest on ML-KEM, while A's rests on HKDF alone.
- **Later**: if WebCrypto ships ML-KEM in stable and the owner wants the short code back, a v3 enrolment can add the KEM
  beside S, or instead of it. The protocol prefix makes that a clean switch.

### (b) Request signing: keep ECDSA P-256 now; be ready for ML-DSA

- **Exposure**: real-time forgery only, after CRQCs exist (§1.1). There is no HNDL, so no change is needed before
  release.
- **Agility already in place**:
  - the signing input is versioned (`sixkey-req|1|`);
  - device public keys are SPKI DER, which carries the algorithm's OID;
  - the fork flow can give a profile a new device key.
- **To write down now** (the doc and the contract text, no code):
  - the server picks the verifier by the SPKI algorithm OID, and refuses an OID it does not know;
  - a new algorithm comes with a new signing-input version and a known signature length (ML-DSA-65 is 3,309 bytes,
    within the bridge's 8 KiB header limit [verified: FIPS 204 sizes; header limit from M5]);
  - a device moves to a new key by "fork to a new identity" or revoke-and-rejoin, which loses no data.
- **A negotiated `sig_alg` is not needed**: the key's OID is the identifier.
- **When**: when ML-DSA is in stable WebCrypto at our minimum Chrome version, or earlier if NIST IR 8547's timeline
  (classical public-key algorithms deprecated after 2030, disallowed after 2035, still a draft [secondary]) or a credible
  CRQC estimate demands it. The server side needs a Python ML-DSA verifier [unverified: availability in
  pyca/cryptography at that time].

### (c) The key hierarchy: confirmed symmetric

- Nothing relies on public-key cryptography for confidentiality at rest. The VK reaches a device through exactly three
  routes:
  - the password wrap;
  - the recovery wrap;
  - the approval payload (fixed by (a)).
- After (a), **no confidentiality anywhere depends on public-key cryptography** except the TLS hop (d′ below). Device
  signatures provide authentication only.

### (d) The recovery key and the master secret

- **VK**: 256 bits. Keep.
- **Recovery key**: 128 bits. Keep: NIST category 1 under Grover. 160 bits is optional (owner question 2).
- **Pairing code**: 128 bits.
- **Master password**: the existing strength policy (the 12-character floor; below 50 estimated bits a warning since
  OWNER-DECISIONS/15) and PBKDF2 ≥600k (2M for new wraps). A memory-hard KDF would help against *classical*
  guessing more than anything quantum. It is out of scope here (no WASM; pure-JS Argon2 is slow).

### (d′) TLS (M8 checklist addition)

- Chrome has offered **X25519MLKEM768** by default since **Chrome 131** (November 2024), replacing the earlier Kyber
  draft group [secondary].
- M8 must check that the API's TLS terminator (the reverse proxy) negotiates it. Then the email, OTP, `pw_auth` and
  metadata on the wire are also safe from harvest-now-decrypt-later by a network observer.
- The server itself sees them anyway; that is the zero-knowledge model.

### (e) WebAuthn PRF paths: vendor-controlled, note only

- The PRF secret is computed on the authenticator (HMAC). Between browser and authenticator, CTAP2 protects it with an
  ECDH P-256 key agreement [unverified detail for each vendor].
- **Local authenticators** (Touch ID, Windows Hello, USB keys) never put that exchange on a network.
- **The phone "hybrid" transport** runs it over BLE and a tunnel service. Someone recording that tunnel who later has a
  CRQC, **and** a copy of the profile's `sk_prf`, could in theory unwrap the vault key [unverified].
- Recommendation for QUICK-UNLOCK's text: prefer platform or USB authenticators for the persistent PRF unlock. Sixkey
  cannot change the vendors' protocols.

---

## 3. Crypto-agility checklist (before the first release)

**Present already**:

| Item | Where |
|---|---|
| Envelope format and cipher identifiers | `EncryptedVault.format`, `formatVersion: 1`, `cipher: "AES-256-GCM"` |
| Keyring version and KDF parameter objects | `Keyring v: 1`; each wrap's `method`, `kdf {name, hash, v}` |
| Key-bundle version | `KeyBundle.format`, `v: 1` |
| Enrolment payload version | `sixkey-enroll-payload`, `v: 1` |
| Versioned labels and domain tags | `sixkey/v1/...`, `sixkey-*\|1\|` (contract H8 check) |
| Signing input version | `sixkey-req\|1\|` |
| Algorithm of a device key | the SPKI OID |
| Vault schema version | `schemaVersion`, derived from content |

**To add before the gate opens**:
- the enrolment protocol at v2 (§2(a)), with N and A refusing a mismatched version clearly;
- the contract sentence "the signature verifier is chosen by the SPKI OID; unknown OIDs are refused";
- the M8 TLS check (§2(d′)).

**"Never lose data" in a future migration**:
- **Symmetric parts**: no quantum-driven migration is needed. If one were ever wanted, the existing rules already make
  it safe: old formats stay readable forever, previous VKs stay in the keyring, and the rotation re-encrypts.
- **Signatures**: a key change per device (fork or rejoin). The vault is untouched; the worst case is re-enrolling a
  device.
- **Enrolment**: a protocol version. No stored data is involved; an enrolment interrupted across versions is simply
  restarted.
- **The one rule to keep**: never drop the reader of an old envelope or keyring version.

---

## 4. Staged plan

| Stage | What | Effort | Why now or later |
|---|---|---|---|
| **Before the sync gate** | Pairing code in the approval join (enrolment v2): M1 crypto and state machines, the vectors and labels, M6's two approval screens, tests | about 5 days | protocol-affecting; free now (nothing shipped), a migration later |
| **Before the gate** | Doc and contract sentences: OID-chosen verifier, enrolment version handling; SYNC-DESIGN revision (§3.2, §2.2, §10, §13 wording) | about 0.5 day | agility costs nothing now |
| **M8** | TLS terminator offers X25519MLKEM768; checked from Chrome | under 0.5 day | transport HNDL |
| **Prepare** | Track WebCrypto ML-KEM and ML-DSA (Chrome origin trial M151–154); a Python ML-DSA verifier for the server | watch | no shippable browser API yet |
| **Later** | ML-DSA device keys (a new device-key flow through fork), when stable Chrome at our minimum version has it, or by 2030 at the latest under NIST IR 8547's draft timeline | about 2 weeks | real-time threat only |
| **Optional** | A hybrid KEM to bring back a short code (enrolment v3) | about 1.5 weeks with WebCrypto | only if the owner rejects the long code |

---

## 5. Honest claims

**What holds**, and so may be said (after stage 1 and the M8 check):
- the vault is encrypted with AES-256 under keys derived with SHA-256-based KDFs, which current guidance considers
  secure against known quantum attacks;
- no part of the vault's confidentiality depends on public-key cryptography, so recorded traffic stays private even
  against a future quantum computer;
- pairing a new device uses a one-time code that never leaves the user's screens;
- connections to Sixkey's server use hybrid post-quantum key exchange (X25519MLKEM768) where the browser supports it;
- device signatures (ECDSA P-256 today) are designed to move to NIST's post-quantum signatures when browsers support
  them (crypto-agility).

**May not say**:
- "quantum-proof", "post-quantum certified", or "uses NIST post-quantum algorithms": we use none, and nothing is
  certified;
- an unqualified "quantum-resistant": device signatures are not;
- anything about the PRF unlock's transport, which the vendors control.

**Before stage 1**: only "symmetric encryption at rest". The join's exposure must not be hidden.

---

## 6. Owner-level questions

1. **The approval join's longer code.** Accept typing a 28-character pairing code on the new device in place of the
   6-digit confirmation code (the 6-digit SAS stays)? *Recommendation: yes.* It removes the only harvest-now-decrypt-later
   exposure with no new dependency, and copy and paste covers the same-machine case.
2. **The recovery key's length.** Keep 128 bits (NIST category 1 under Grover), or lengthen to 160 bits (8 more
   characters)? *Recommendation: keep 128.*
3. **Public claims** about quantum attacks, for the store listing and the website (their wording: OWNER-DECISIONS/06).
   *Recommendation: what §5 says holds, and nothing stronger.*

---

## Sources

- blink-dev, "Intent to Experiment: Algorithm Updates in WebCrypto" (2026-06-17; DevTrial M150, origin trial M151–154,
  flag `webcrypto-pqc`): https://groups.google.com/a/chromium.org/g/blink-dev/c/TF8y175J3YU/m/J4thHvVVAAAJ
- WICG, Modern Algorithms in the Web Cryptography API: https://wicg.github.io/webcrypto-modern-algos
- Cloudflare, ML-KEM and ML-DSA in Workers (the same "Modern Algorithms" draft): https://blog.cloudflare.com/workers-ml-kem-ml-dsa-support/
- noble-post-quantum README (MIT; not independently audited; no constant-time claim; ML-KEM ~7 KB gz; `ml_kem768_x25519`
  = X-Wing): https://github.com/paulmillr/noble-post-quantum
- X25519 in Chrome WebCrypto (Chrome 133) and Ed25519 (Chrome 137), secondary: https://blogs.igalia.com/jfernandez/?p=1913,
  https://blog.ipfs.tech/2025-08-ed25519/
- Chrome's X25519MLKEM768 default since Chrome 131, secondary: https://postquantum.com/security-pqc/rfc-10024-hybrid-mlkem-tls/,
  https://github.com/cloudflare/cloudflare-docs/pull/20158/files
- FIPS 203/204/205 final on 2024-08-13; FIPS 206 (FN-DSA) a draft; NIST IR 8547 a draft (deprecate after 2030, disallow
  after 2035), secondary: https://appviewx.com/blogs/a-closer-look-at-nists-legacy-encryption-algorithm-transition-plans-and-finalized-pqc-algorithm-standards
  (check csrc.nist.gov before quoting).
