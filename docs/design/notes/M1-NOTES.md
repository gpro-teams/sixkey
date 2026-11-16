# M1 notes: `core/sync/crypto`

Milestone M1 of `docs/SYNC-DESIGN.md`, §9 row M1, tested against §8.1. First written against revision 6, brought up to **revision 7** (§0.0f, after `docs/audit/internal-reviews/M1-REVIEW.md`).

- Code: `extension/src/core/sync/crypto/`. It is pure (WebCrypto only, no I/O, no `chrome.*`), and nothing outside `core/sync` imports it yet.
- Tests: `extension/test/unit/sync-crypto-*.test.ts`. The review's K0–K11 and REPRO regressions are in `sync-crypto-review.test.ts`; the crypto-level adoption tests (F-02, F-03, F-06, F-07, `capPrevious`, T-02) are in `sync-crypto-adoption-crypto.test.ts`.
- The doc was not edited. For revision 7 the owner allowed M1 to resync `api/` and `contract/` to §0.0f; that resync is recorded in `contract/M0-NOTES.md` ("Revision 7 resync").

## M1-1 – M1-15: all specified by revision 7

§0.0f gives every one of them a rule. The code now follows that rule; the column on the right says where.

| # | Section | Issue (first pass) | Revision 7 rule, now implemented |
|---|---|---|---|
| M1-1 | §3.9 R2 (P3), §2.5 | "auth may only change with the password wrap" needs the auth that came with the local password wrap, which nothing stored. | = F-07. `adoptedAuth` (identity `adopted.auth`) is a required input, `null` only right after an identity restore. In the in-sync branch a known `adoptedAuth` ≠ `bundle.auth` is `auth_without_password`, on all three paths (adopt, unlock, pre-send). |
| M1-2, M1-2b | §3.9 R2 | ids over garbage bytes; and the reverse denial of service. | Written into R2: both sides of the containment count only entries that really unwrap (`unwrappedPreviousIds`, `realPrevious`). Unchanged in the code. |
| M1-3 | §3.9 R2/R3 | "oldest few" was not exact. | = F-02 + S-5. Same VK: no exception at all. Another VK: only when the remote list has exactly 64 real entries, the missing ones must be a leading run of the local real entries **in list order** (not `(createdAt, vkId)`). `PreviousRef` is just `{vkId}`. |
| M1-4, M1-5 | §3.14, §4.2 | `respond` in `keys_behind`; repair when not behind. | Written into §3.14 / §4.2: `respond` waits with `approve`; repair when not behind is `not_behind`. Unchanged. |
| M1-6, M1-7 | §2.3 | auth salt rule; non-integer number tokens. | Written into §2.3: the auth salt rule is a client generation rule (upload mode only; mutant M06 is now killed by K6); clients also reject non-integer tokens. Unchanged. |
| M1-8 | §3.2 M7 | unknown members of P. | Ignored. Unchanged. |
| M1-9, M1-10 | §2.5, §3.6.0 | backup layout; recovery-wrap fingerprint. | Written into the doc as implemented. Unchanged. |
| M1-11 | §3.9 R0/R1 | classify only MAC-verified bundles. | = F-08. R0 order everywhere: vaultId, then MAC, then classification. `classifyKver` is no longer exported from `index.ts`. |
| M1-12, M1-13 | §8 | seeded simulations; 10⁵ sessions too slow. | Written into §8 as implemented. Unchanged. |
| M1-14, M1-15 | §3.2 MUST 9 | malformed code input; states ahead / reflected keys. | Written into MUST 9 as implemented. Unchanged. |

## What revision 7 changed in the code (§0.0f items 1–11)

1. `KVER_MAX_JUMP = 65536`. `publishKver(s, m) = min(max(s, m) + 1, s + KVER_MAX_JUMP)`, `kver_overflow` when the result is not a safe integer.
2. `classifyKver`: when `m > 0` and `kver > m + KVER_MAX_JUMP`, it classifies as `kver ≤ m` (no raise, different content = `keys_behind`). No cap when `m = 0`. Internal only, called after vaultId and MAC.
3. `previousCovers(local, remoteIds, sameVk)` as in M1-3. All three same-VK call sites pass `true`.
4. `capPrevious(keyring)`: the last 64 entries in list order. M1 has no rotation builder yet; M3 calls it after `rekey`, before `sealBundle`.
5. `expectedVaultId` is required by `evaluateSameVkBundle`, `unlockWithSync` and `preSendCheck`; a mismatch is `wrong_vault`.
6. `adoptedAuth` and `adoptedDigest` are required. With the local keyring lost, "same content" means `adoptedRecord(bundle).digest === adoptedDigest`. `adoptedRecord(bundle) → {digest, auth}` is exported, `digest = b64(SHA-256(canonicalJson({keyring, auth})))`.
7. `preSendCheck` takes the raw server text. Order: parse → vaultId → MAC (the local VK, or the older VK `unwrapPreviousVks` returns; neither → `needs_adoption`) → classify → gates → R2. Success returns a frozen, branded `VerifiedServerBundle {raw, bundle, vk, op, keysBehind}`. `isVerifiedServerBundle` checks the brand.
8. `verifyReceivedBundle(raw, vk, expectedVaultId)` checks vkId, vaultId and MAC, and throws `invalid_bundle`, `wrong_vault` or `bad_mac`. The new device uses it on P's bundle with P's own `vaultId` and VK. `NewDeviceEnrollment.#keys` is gone (F-12).
9. Both machines (MUST 7): each transition computes into locals and commits in one synchronous block, guarded by an epoch that `#fail` increments. The first failure wins; an abort during an await makes the step return `{kind: "failed"}` with no body, CC or keys. `startApproval` takes only a `respond` check that is not `keysBehind`; `buildApproval` only an `approve` check that is not `keysBehind` (a wrong object throws `invalid_argument` and does not end the request).
10. `ApproverEnrollment.onPoll` (MUST 8): in `approving`, `approved` with every pinned value unchanged gives the same result as `approveAccepted()`, which is idempotent. `approved` in `verifying` or `sas_ok` is still `unexpected_state`. Missing view fields from the F-10 states are `tampered` on both sides.
11. Tests: K0–K11; REPRO-1 (four MUST 7 cases, aborts injected inside encrypt, decrypt and digest), REPRO-2 (MUST 8), REPRO-11 (kver exhaustion); F-02 on the three same-VK paths plus a multi-rotation catch-up through a full 64-entry list; F-03, F-06 (REPRO-5), F-07 (also after local loss), the kver cap, `capPrevious` (REPRO-8); M06; T-02 (below).

## New observations from revision 7

| # | Section | Issue | M1 does | Proposed fix |
|---|---|---|---|---|
| M1-16 | §3.9 R1/R2, F-06/F-07 | With the local keyring lost there is no password wrap to compare, and `adopted.digest` only says "same" or "not same". A VK holder could republish the adopted keyring with a different `auth` (same keyring, new auth): the digest differs, so it is not in sync, and with no local wrap "auth changes only with the password wrap" has nothing to hold on to. The T-02 sequence model found it. | `unlockWithSync` recomputes the digest with `adopted.auth` put back. If that reproduces `adopted.digest`, only auth changed: `auth_without_password`. | Add to R2: "with the local keyring lost, a bundle whose keyring reproduces `adopted.digest` under `adopted.auth` but whose auth differs is `auth_without_password`." |
| M1-17 | §3.9 R6 | A recovery-code unlock (R6) opens only the recovery wrap, so it can adopt a bundle whose password wrap is garbage. The user is not locked out (the recovery key still opens the adopted keyring), but the password stops working until it is changed. | As the doc says: R6 follows the same rules. T-02's "never locked out" invariant is stated as "opens with a secret the user has proven or still knows". | Optional: after an R6 adoption, prompt to set the password again (the §3.3 flow already ends there). |
| M1-18 | §3.2, F-09 | "Check again before approve" does not name the outcome when the VK changed between the respond check and the approve check. | The request ends with failure `keys_changed`; the caller follows R3 first. | Name it in §3.2. |
| M1-19 | §3.14, F-09 | F-09 also gates the `PUT /v1/keys`, rotate and repair builders. M1 has none of them; they are M3. | `VerifiedServerBundle` is ready for them. The brand is a module-private `WeakSet`, so a copy, a structured clone (for example across `chrome.runtime` messaging) or a hand-built object is refused. | M3 must run `preSendCheck` in the same context as the builder. |
| M1-20 | §8, T-02 | "Optionally run fact sequences through `unlockWithSync` with a test-only 1-iteration KDF". Phase 0 refuses PBKDF2 below 600 000 iterations when it reads stored params (`kdf.ts`), so a 1-iteration wrap cannot be opened without a test seam in Phase 0 code. | The real-function sequence model unlocks with recovery keys (HKDF, cheap) and checks password wraps by bytes. No Phase 0 change. Runs: 40 by default, `SIXKEY_T02_RUNS` for more (6 × 40 and 1 × 300 were run clean). | None. |

The contract side (`facts_only` on the three classification-only adoption vectors, the new `keys_repair.p4_cases` because no P4 vector set existed, `if`/`then`/`else` in both schema validators, and a `Kver.maximum` counterexample) is in `contract/M0-NOTES.md`.

## Mutation check (revision 7)

Each mutant is an exact, single-occurrence replacement on a scratch copy; the whole suite runs per mutant (`npx vitest run`, 38 files). Script and results are kept outside the repo.

- **The review's 11 survivors**, re-expressed on the revised code (M01–M06, M21, M22, M23, M33, M36): all killed, each by its K test (K1–K11).
- **New rules** (25 mutants, N01–N19 with a/b/c for rules that live on several paths; the number N13 is not used): all killed. They cover the cap (removed, or also at m = 0), `publishKver` (no min, no overflow check), `previousCovers` (same-VK 64 exception back, leading run relaxed), `wrong_vault` on the adopt, unlock and pre-send paths, the F-06 digest, F-07 on the three paths including the after-loss case (M1-16), the three MUST 7 epoch guards, MUST 8 and the idempotent `approveAccepted`, `capPrevious` keeping the first 64, the brand check in `start`, `keys_changed`, both F-10 field checks, the pre-send MAC (F-08), and `respond` in `keys_behind`.
- **Contract** (C01–C16, against the Python tests, `gen-vectors --check` and the TS contract tests): all 16 killed. C16 (`Kver.maximum` dropped) first survived; a wire counterexample (`GET /v1/keys` with kver 2^53) now kills it.

## Vector items that are not client code

Most of the 24 groups are reproduced byte for byte by the production functions; the coverage meta-test in `sync-crypto-vectors.test.ts` maps every array of cases. These are left to other owners:

| Item | Owner |
|---|---|
| `request_signature.p1363_to_der` and `sig_der_hex` | The server (§5.1 `wire.py` converts P1363 to DER); clients never do. The client checks the P1363 range (`0 < r, s < n`). |
| `kver_rules.server_accept` | Server logic for M4 (`if_kver < kver ≤ if_kver + KVER_MAX_JUMP`, CAS on `if_kver`, idempotent identical text). |
| `envelope.must_not_open` | Phase 0 `decryptVault`, already run by `contract-vectors.test.ts`. M1 adds only the envelope text, size and head. |
| `wire_examples` response bodies and counterexamples | Schema-only checks (`contract-vectors.test.ts`). The request bodies M1 builds are reproduced exactly: enrollment request, respond, reveal and approve; init `name_ct`, `write_key` and the verifiers; PUT `write_proof`; recovery `recovery_auth`; rename and fork `name_ct`; rotate and keys repair. |

Day and minute truncation are server precisions. They are tested through the same `floorToUnit` the client uses for hours.

## Design choices that need no doc change

- **State-machine form.** The two enrollment state machines are objects with private fields and an explicit `phase`, not functions that return new state values. That makes the §3.2 MUST rules structural:
  - a pinned value cannot be replaced;
  - the SAS is computed once;
  - two concurrent transitions are refused;
  - no transition leads back to a new request;
  - terminal states drop the ephemeral key and K;
  - a failure, including an `abort()` during an await, wins over the step in flight (epoch guard, MUST 7).
- **Purity.** Both machines do no I/O. The caller sends the bodies they return and feeds them each poll and each typed code.
- **Test seams.** Fixed keys, rng and a small code space can be injected for the vectors and the adversary model. The public `index.ts` does not expose these, nor `classifyKver` and `sameVkVerdict`; a test asserts that.
- **Read and upload modes.** Bundle validation has two modes. `"read"` is what clients accept: it does not check hour alignment (N16). `"upload"` is what the server enforces, and clients run it on their own output.
- **P4 before sending.** `requiredVerifiers(serverBundle, newBundle)` applies the server's keyless P4 rule (§2.3) before any `PUT /v1/keys` or rotate is built:
  - the recovery wrap changes ⇔ `recovery_verifier` is sent;
  - the password wrap changes ⇔ `auth.kdf` changes ⇔ `password_verifier` is sent.

  Wraps are compared by their iv and wrapped bytes only (S-2), so a `createdAt`-only difference needs no verifier. A bundle that breaks the rule throws, so a request the server would refuse with 422 is never sent.
- **K_write.** It is the only VK subkey derived as bytes, because it travels as `write_key`. All other derived keys are non-extractable CryptoKeys, and HMAC keys are derived with an explicit `length: 256` (N3).

## Limitations

- **Timing.** Timing independence cannot be tested from JavaScript.
  - MAC checks use `crypto.subtle.verify`. `bytesEqual` does not short-circuit, but the JIT gives no guarantee.
  - SAS and CC are compared as strings. They are not long-term secrets, and only three attempts are allowed.
- **Wiping.** Memory wiping is best effort. M1 zeroes the byte arrays it owns: Z, the PBKDF2 output, the K_write bytes, the decrypted payload and the backup plaintext. Strings (such as `pw_auth` in base64) and the Phase 0 `Vk.raw` stay in memory until garbage collection.
- **Runtime.** Everything ran under Node's WebCrypto only. Chromium 120 and 134 behaviour (ECDH `deriveBits`, HKDF→HMAC `deriveKey` with a length, JWK import) is for the §8.6 old-engine CI in M5/M6.
- **Callers.** The `adopted` record, `vaultId` in the identity (M2) and the rotation builder that calls `capPrevious` (M3) do not exist yet; M1's tests pass these values directly.
