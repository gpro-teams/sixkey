# M0 notes: API contract and shared vectors

Milestone M0 of `docs/SYNC-DESIGN.md`: §5.4 as `api/openapi.yaml`, the error-code table, and the shared known-answer vectors.

**Status (revision 18). Nothing is open.**
- The first M0 pass raised N0–N26. Revision 5 of the doc accepted all 26 and resolved them in **§0.0d**.
- The revision-5 resync raised N27–N29. Revision 6 accepted all three and resolved them in **§0.0e**.
- The M1 review (`docs/audit/internal-reviews/M1-REVIEW.md`) led to revision 7 (**§0.0f**). Its "契约 / 向量必须改成" ("the contract / vectors must become") column is applied as listed in [Revision 7 resync](#revision-7-resync-00f).
- Revisions 8–14 asked for no contract change. The M4 backend review (`docs/audit/internal-reviews/M4-REVIEW.md`, `docs/design/notes/M4-NOTES.md` A1–A30, S14) led to revision 15 (**§0.0o**). Its "M0 实现者要改的契约" ("contract changes for the M0 implementer") items 1–16 and "M0 实现者要加的向量" ("vectors for the M0 implementer to add") are applied as listed in [Revision 15 resync](#revision-15-resync-00o).
- The M4 fix pass led to revision 16 (**§0.0p**). Its "M0 实现者要改的契约" ("contract changes for the M0 implementer") items 1–6 are applied as listed in [Revision 16 resync](#revision-16-resync-00p); its vectors are unchanged.
- The M4 cleanup round led to revision 18 (**§0.0r**; revision 17 asked for no contract change). Its "M0 实现者要改的契约" ("contract changes for the M0 implementer") items 1–9 are applied as listed in [Revision 18 resync](#revision-18-resync-00r); its vectors are unchanged.
- The contract, vectors, generator, Python reference, TS tests and checker follow both change logs' "契约 / 向量必须改成" ("the contract / vectors must become") column. Each item below says how.
- The doc was never edited from here.

## Files and how to run

| File | What it is |
|---|---|
| `api/openapi.yaml` | OpenAPI 3.1 contract: 29 operations, error-code table, constants, rate limits, request rules (`x-sixkey-request-rules`, revision 16), signature spec, and tombstones for removed items (`x-sixkey-removed`). |
| `contract/vectors/sync-v1.json` | The one shared vector file (§2.2, §8.1): 24 groups. Revision 7 changed `kver_rules`, `keys_repair` (new `p4_cases`), `wire_examples`, two rule texts and the `source` line, nothing else. Revision 15 changed only `wire_examples` and the `source` line. |
| `contract/vectors/sync-v1.schema.json` | JSON Schema for the vector file. |
| `contract/tools/gen-vectors.mjs` | Node WebCrypto reference generator. It imports nothing from `extension/src`. |
| `contract/py/sixkey_contract.py`, `contract/py/test_contract.py` | Python loader, validators, and a separately written reference implementation (see "Caveats on independence" below). |
| `contract/tools/check_consistency.py` | Cross-checks the design doc against the contract (H1–H10, S1). |
| `extension/test/helpers/contract.ts`, `extension/test/unit/contract-vectors.test.ts`, `extension/test/unit/contract-openapi.test.ts` | TypeScript loader, plus vitest checks that run inside `npm test`. |

```
node contract/tools/gen-vectors.mjs --check                 # recompute every vector with WebCrypto; fails if the file differs
python3 -I contract/py/test_contract.py                    # Python: schema, OpenAPI, every vector group, cross-file
SIXKEY_CONTRACT_NO_CRYPTOGRAPHY=1 python3 -I contract/py/test_contract.py   # the stdlib-only path (AES-GCM reported as skipped)
python3 -I contract/tools/check_consistency.py              # doc <-> contract; exit 1 on a hard mismatch
cd extension && npm run typecheck && npm test               # includes the two contract test files
```

To regenerate the vectors, run `node contract/tools/gen-vectors.mjs` and review the diff. ECDSA signatures are randomized, so the generator keeps each existing signature as long as it still verifies. Reruns therefore do not churn the file.

## What each implementation verifies

| Group | Node generator | TS vitest (WebCrypto + shipped Phase 0 code) | Python stdlib | Python `cryptography` |
|---|---|---|---|---|
| labels: pairwise distinct, prefix-free | yes | yes; also every `sixkey/v1/...` literal in `src/core/crypto` is listed | yes | - |
| base64url, base64, canonicalJson, time truncation, padding | yes | yes (Phase 0 `toB64`/`fromB64`/`canonicalJson`) | yes | - |
| VK subkeys, write proof, recAuth, pw_auth | yes | yes (Phase 0 `hkdfBits`, `pbkdf2Bits`, `normalizePassword`, `parseRecoveryCode`, `assertKdfParams`) | yes (HKDF written out, `pbkdf2_hmac`) | - |
| envelope, incl. tampering | yes | Phase 0 `encryptVault` reproduces it; Phase 0 `decryptVault` rejects every tampered copy | checksum, head, AAD | AES-GCM |
| KeyBundle MAC and shape, incl. unaligned times | yes | MAC; Phase 0 `validateKeyring`, `unlockWithPassword`, `unlockWithRecoveryCode`, `unwrapPreviousVks` | MAC, shape rules, KEKs | wraps decrypt |
| number tokens (`3.0`, `1e3`, …) | yes | raw-text token scan | strict `json.loads` (parse_float / parse_int / parse_constant hooks) | - |
| device name (revision-5 rule), device backup | yes | rules + AES-GCM | rules, AADs | AES-GCM |
| public keys | yes | JWK -> raw/SPKI export | pure-Python P-256 `d·G`, SPKI layout, on-curve | SPKI |
| enrollment (incl. the padded 188-byte reveal name) | yes | yes | everything except AES-GCM; ECDH in pure Python | ECDH, AES-GCM |
| request signatures; fork `Sixkey-Sig` + `Sixkey-New-Sig` | yes | ECDSA verify, DER | signing input, DER, pure-Python ECDSA verify | ECDSA verify |
| repair rotate (§4.2) | yes | full body: VK2 envelope/bundle, K_write of VK1, kver = max(server, maxSeen) + 1, both verifiers, Phase 0 unlocks keyring2 | everything except AES-GCM | envelope, wraps, previous, names |
| same-VK repair through `PUT /v1/keys` (§4.2, N27) | yes | jumped kver, P4 verifiers, MAC; Phase 0 unlocks the keyring with the password and code 3 | everything except AES-GCM | both wraps open |
| kver rules: publish (cap, kver_overflow), server accept (jump bound), R0/R1 adoption with the cap (§3.9) | yes | own implementation of the three rules; M1's `publishKver` / `classifyKver` also reproduce them (`sync-crypto-vectors.test.ts`) | own implementation of the three rules | - |
| P4 consistency, wraps by iv + wrapped (§2.3, S-2) | yes | own implementation; M1's `requiredVerifiers` too | own implementation | - |
| wire examples vs OpenAPI schemas, incl. counterexamples | - | yes | yes | - |
| strict JSON of nested texts (§5.4, §0.0o A18, S14): integer tokens, no duplicate keys, NaN/Infinity, NUL or lone surrogates | - | own recursive-descent parser (`parseStrictJson`) | `json.loads` hooks plus a walk over keys and strings (`parse_strict_json`) | - |

Caveats on independence:
- **Labels.** All three verifiers read the label strings from the vector file. To catch a typo copied into the generator, `check_consistency.py` H8 asserts that the doc's 11 HKDF labels and 16 domain tags equal the vector file's lists. The one exception is the Phase 0-only `kek-device`.
- **Shared OpenSSL.** Node WebCrypto and pyca/cryptography both sit on OpenSSL. The pure-Python P-256 code is the only check of the EC math that does not depend on OpenSSL. It is test-only: not constant time, never for real keys.
- **AES-GCM.** There is no stdlib AES-GCM, so pyca/cryptography is its only independent check. Without it, those checks print `skipped`, never `ok`.
- **Authorship.** The Node generator, the Python reference and the extension are separate code, but not independent
  work: all three were written in the same AI-assisted process from the same design text, so a misreading of the
  design that they share passes every check here. Only an external review or an implementation written by someone
  else can catch that.

## N0–N26: resolved in revision 5 (§0.0d)

| # | Was | Resolved in §0.0d by | Contract / vectors now |
|---|---|---|---|
| N0 | the file was written in JSON syntax because no YAML parser was available | accepted, no doc change | unchanged |
| N1 | fork `new_sig` in the body could not sign a signing input that hashes that same body | header `Sixkey-New-Sig` over the same signing input (§4.10, §5.2, §5.4) | `ForkRequest` has no `new_sig`; a required `Sixkey-New-Sig` header parameter (base64url, 64-byte P1363); a missing or wrong value is 401 `bad_signature`. Vector group `fork_signature`: one signing input, both signatures verify, four negatives. Checker H10. |
| N2 | `If-None-Match: "v{n}"` answered 304 for a reused version (defeats D5) | conditional GET removed (§5.4 row and 已删除, "removed") | `IfNoneMatch`, `ETag` and 304 are gone; `x-sixkey-removed` lists them. Checker H9 and both loaders assert their absence. |
| N3 | HKDF/HMAC key lengths were unstated | §2.2: 256 bits except vk-id; HMAC keys need `length: 256` | stated as a vector rule; the 512-bit counterexample is kept |
| N4 | hour truncation wording; Postgres session time zone | §2.3 floor to the UTC hour; §5.3 `ALTER ROLE sixkey_api SET timezone = 'UTC'` | rule text cites §2.3/§5.3. **M4's migration must contain the `ALTER ROLE`.** |
| N5 | device-name edges | §2.4: NFKC, trim U+0020, reject in order (not well formed, empty, > 40 code points, Cc, bidi control, zero width); §3.2 pads the reveal name | device-name vectors: 32 cases. Bidi, zero-width, all-spaces, trimmed, precedence and 40-emoji cases are included. The reveal `name_ct` is 188 bytes on the wire (`wire_bytes`). |
| N6 | how the IV is carried for K_enroll ciphertexts; `vkId` vs `vk_id` | §3.2 `iv ‖ ct ‖ tag`; §5.3 comment says `vkId` | unchanged; descriptions cite §3.2/§2.4 |
| N7 | payload `bundle`: object or text | §3.2 M5: the raw text; `P.at` is exact ms | unchanged |
| N8 | signer header for the registration endpoints | §5.2 `Sixkey-Device: {body device_id}` | unchanged |
| N9 | signing host/port, target, empty body | §5.2 | unchanged |
| N10 | account-session header | §5.2 `Authorization: Bearer` | unchanged |
| N11 | eight unnamed error codes | §5.4 通用错误码 (common error codes) | the eight codes are now `source: doc`. No contract code is `m0` any more. |
| N12 | error-body details, `server_time`, rate-limit scope | §5.4 响应 (responses); §5.5 non-GET requests 30/min | unchanged; the 304 note was dropped with N2 |
| N13 | body-limit units; rotate under the 64 KB limit | §5.4 per-endpoint limits, MiB throughout | `MAX_BODY_BYTES_VAULT` and `HISTORY_MAX_BYTES` are `source: doc` |
| N14 | API timestamp format | §5.4 integer ms; `last_seen_at` = UTC midnight | unchanged |
| N15 | `devices_changed_at` had no column and missed changes | `devices_rev` counter (§4.2 step 1, §5.3) | status returns `devices_rev` (required); the old name is tombstoned. Wire example plus counterexample. |
| N16 | rejecting bundle times not aligned to the hour | §2.3: server 422; clients don't check on read | `multipleOf: 3600000` kept; the 422 text is on init, `PUT /v1/keys` and rotate; three unaligned shape cases; one wire counterexample |
| N17 | `cursor.cur` optional | §5.4 PUT row `cur?` | unchanged; the checker's accepted-deviation list is now empty |
| N18 | byte-field encodings | §5.4 编码 (encodings) | unchanged, except that the fork new-key signature is now a base64url header |
| N19 | base64url strictness | §2.2 | unchanged |
| N20 | canonicalJson is cross-language only for integers | §2.3, §5.4: safe integers only; non-integer tokens rejected | new vector group `number_tokens`: `3.0`, `1.7920512e12`, `6e5`, `1e3`, `1E3`, `-1.5`, 2^53+1 rejected, plus positives. Checked on the raw text in both languages. The 422 text is in the contract. |
| N21 | `min_client_version` format | §5.2 | unchanged |
| N22 | six endpoints no protocol step named | named in §3.2, §3.10, §3.14, §4.2, §4.3, §5.1 | checker S1 = 0 |
| N23 | padding at an exact multiple of 16 KiB | §4.1 | unchanged |
| N24 | repair rotate could not compute `recovery_verifier` | §4.2: the recovery code is typed or newly generated; a rotate without a VK change | rotate description gives the repair use. New vector group `rotate_repair`: a self-consistent body, plus a counterexample without `recovery_verifier`. |
| N25 | DELETE with a body | §5.4 fail-closed; §8.4 proxy test | unchanged (M4/M8 test) |
| N26 | Q11 open | decided: pause removed | unchanged |

## N27–N29: resolved in revision 6 (§0.0e)

| # | Was | Resolved in §0.0e by | Contract / vectors now |
|---|---|---|---|
| N27 | after an honest rollback, R1 (which rejected only `kver < maxSeenKver`) refused reused kvers, and the pre-send check could block every `pw_auth` operation; a lagging device's different content at an equal kver was adopted silently | publishers use `max(server kver, maxSeenKver) + 1`; the server accepts any `kver > if_kver` with the CAS still on `if_kver`; idempotency = identical stored text; R1 adopts only `kver > maxSeenKver`, otherwise same content is in sync and different content is the new client state `keys_behind` (no "take the server's", repair only, R3 confirmation, revocation never blocked); `maxSeenKver = 0` on identity restore (§2.3, §2.5, §3.6.0, §3.9, §3.14, §4.2, §5.4) | `PUT /v1/keys` and rotate: `kver > if_kver`, `if_kver` ≠ the server's kver is 409 `keys_conflict`, identical text is the idempotent 200; `keys_conflict` meaning updated. Vectors: `rotate_repair` now publishes kver 7 = max(3, 6) + 1; new group `keys_repair` (same-VK repair through `PUT /v1/keys`: `if_kver` = server kver, jumped kver, `recovery_verifier` and `password_verifier`, also a wire example); new group `kver_rules` (publish cases, the server's accept order, 8 R1 adoption cases incl. the three `keys_behind` sequences: rollback, lagging publisher at an equal kver, replay after the repair). |
| N28 | rejecting U+200D also rejects emoji ZWJ sequences | rejection kept; §6 O3's naming hint explains it (emoji data tables would bring back cross-runtime Unicode drift) | unchanged: the "ZWJ U+200D inside an emoji sequence" rejection vector stays |
| N29 | §9's M0 acceptance line contradicted §0.0d about S1 | §9 now says "S1 为 0" ("S1 is 0") | unchanged; the checker reports S1 = 0 |

## Revision 7 resync (§0.0f)

| Item | Contract / vectors now |
|---|---|
| F-01 | `x-sixkey-constants.KVER_MAX_JUMP` = 65536 (unit kver, §2.3 / §3.9 R0/R1, source doc, enforced_by both). `Kver` has `maximum: 9007199254740991`. The `PUT /v1/keys` and `POST /v1/keys/rotate` descriptions, the `KeyBundle` description and the `invalid_request` meaning say `if_kver < kver <= if_kver + KVER_MAX_JUMP, else 422 invalid_request` and give the `publishKver` formula. `kver_rules` has `kver_max_jump`, the rule text in the new form, publish cases (5, 100000) → 65541 and (2^53−1, 0) → `error: kver_overflow`, server-accept cases at the bound (if_kver 3: kver 65539 → 200 applied, 65540 → 422), and three adoption cases at the client cap. One more wire counterexample, `GET /v1/keys` with kver 2^53, makes `Kver.maximum` checked (without it, dropping the maximum went unnoticed). |
| F-01, the three new adoption cases | They are classification facts, not real bundles: the referenced bundles only give the content, and `bundle_kver` is the kver under test. They carry `facts_only: true`, so the old check "bundle_kver is that bundle's own kver" still holds for every other case (TS and Python). |
| F-10 | `EnrollNewDeviceView` and `EnrollApproverView` gain `allOf` with `if`/`then` per state (responded, revealed and approved require `approver_device_id` and `approver_epk`, and approved also requires `payload`; revealed and approved require `new_epk`, `new_nonce` and `new_name_ct`). Top-level `required` is unchanged, so H5 still compares §5.4's question marks. Both schema validators (`extension/test/helpers/contract.ts`, `contract/py/sixkey_contract.py`) now implement `if`/`then`/`else`; it is an addition to the keyword subset, so both linters still reject every other keyword. New wire counterexample: a `responded` new-device view without `approver_epk`. |
| F-11 | `KEYRING_PREVIOUS_MAX` section reads §2.3, §3.8 P1, §3.9 R3. |
| S-2 | Both key-operation descriptions say P4 judges a wrap changed by its iv and wrapped bytes only. There was no P4 vector set, so revision 7 adds `keys_repair.p4_rule` and `keys_repair.p4_cases`, five MAC-valid bundles against the keybundle group's server state: both wraps and auth changed, recovery only, **createdAt only (no verifier required)**, auth only (422), password wrap without auth (422). The Python `v_keys_repair` P4 check now compares iv + wrapped instead of whole wrap objects. |
| Checker | `check_consistency.py` needed no change: 0 hard mismatches, S1 = 0. |
| Mutation check | 16 mutants of the new rules (Python and TS reference implementations, both validators' `if`, the OpenAPI `if`/`then`, `KVER_MAX_JUMP` in the OpenAPI and the generator, a boundary vector, `Kver.maximum`) were run on a scratch copy against the Python tests, `gen-vectors --check` and the TS contract tests. All 16 are killed; the `Kver.maximum` mutant only after the counterexample above was added. |

## Revision 15 resync (§0.0o)

Each item was checked against the doc section §0.0o points to before it was applied. The numbers are §0.0o's.

| Item | Contract / vectors now |
|---|---|
| 1 (A13) | `EnrollCreateResponse.expires_at` and `EnrollListItem.expires_at` are `MinuteMs`. `MinuteMs` reads "a multiple of 60000 ms (UTC minute boundary): created_at floored, expires_at rounded up". The `createEnrollRequest` description now says (now + 600 s) rounded up, a lifetime of 10 to 11 minutes (§5.3). The existing create-response example uses that value and says so. |
| 2 (A2, A14) | `POST /v1/enroll/reject-all` deletes only open requests, approval and recovery alike, with `created_at <= minute_floor(Sixkey-Ts)`; `rejected` counts the unexpired ones. The stale "pending owner confirmation" for Q11 is gone (decided, §12). |
| 3 (A2) | `x-sixkey-signature.no_nonce_cache` lists the six residuals of §5.2 instead of "the only exception is rename". |
| 4 (A5–A7) | `PUT /v1/keys` and `POST /v1/keys/rotate` give the check order of §5.3. Rotate: `keys_conflict` first when both preconditions are stale. `device_names` (also in `RotateRequest.device_names`): devices of this account only, no duplicates, `name_ct.vkId` = the new VK, unlisted devices keep their name. |
| 5 (A8) | `EnvelopeText`: the UTF-8 byte count is checked first (413 before the schema); `maxLength` is only the schema bound. |
| 6 (A9) | Every one of the 29 operations lists `413: [too_large]` with a 413 response; the 10 bodyless ones are new (`healthz` included). `x-sixkey-max-body-bytes` stays on body operations only; `MAX_BODY_BYTES_OTHER` and `too_large` say bodyless operations are capped at 64 KiB too. Both OpenAPI linters require 413 on every operation. |
| 7 (A10, A21, A22) | Rule: past `invalid_proof_per_device`, 429 + `Retry-After`, no database write. `otp_verify_code` is keyed "email (HMAC), reset by a new code"; a malformed email is 401 `otp_invalid`; attempts are taken before the provider call (S1). New limits `session_writes` (30 / 60 s, init and enrollment create) and `session_reads` (60 / 60 s, `GET /v1/account`), keyed by account session. New rule: an enrolling device is limited as `enroll:{rid}` and counts toward the account ceiling. Ids are unchanged. |
| 8 (A11) | `…/reject`: a device-side request without a proof is 403 `password_mismatch`, not counted. |
| 9 (A16, A17) | `…/complete`: a retry of the same rid is 410 (D4 status query is the way out); a taken device id is 409 `enroll_state`; `name_ct` on the approval path is 422; optional on the recovery path (null name). Also in `CompleteRequest.name_ct`. |
| 10 (A15) | respond and reveal: an identical retry is 200, different values 409; a repeated approve is 409. |
| 11 (A14) | `pending_enrollments` counts unexpired pending approval requests. The list shows approval requests in every state (`handled_by` once responded), never recovery requests; a GET on a recovery request is 410. This follows §5.4's split: only the counter is "pending". |
| 12 (A18) | `info.description`, `invalid_request` and `EnvelopeText`: duplicate keys, NUL and lone surrogates are 422 in bodies, bundles and envelopes; the integer-token rule also applies inside the envelope text. |
| 13 (A19) | The `name_ct.vkId` rule is in the init, approve, complete, rename and fork descriptions (rotate's is item 4). |
| 14 (A20) | `getEnrollRequest`, `rejectEnrollRequest` and `enrollSignature`: exactly one signer header, `Sixkey-Enroll` = the path rid, else 401 `bad_signature`. `x-sixkey-signature.sub` names the operations that carry an account session (A20's second sentence). |
| 15 (A23) | `POST /v1/auth/verify`: a failed immediate logout is 503 `unavailable`. |
| 16 (A12) | The `devices_rev` description lists the `auth_failures` reset (and that cursor writes do not count). |
| Beyond the list | The `putVault` and `rotateKeys` descriptions said "FOR SHARE"; they now say `FOR NO KEY UPDATE` and the lock order of §5.3 A1. Description only. |
| Vectors (A13, A18) | `wire_examples`: the create response's `expires_at` = minute-ceil(now + 600 s) (`ceilMinute` in the generator), and four counterexamples placed in nested texts so the vector format does not change: a duplicate key in a bundle text, an escaped NUL in an envelope text, an escaped lone surrogate in a bundle text, `"rev":42.0` in an envelope text. Each is built by an exact single replacement (the generator throws otherwise), and both test suites show each one passes the schema under a lenient parse, so it fails only on the strict rules. |
| S14 | Both schema validators now parse `contentSchema` texts strictly (`parse_strict_json`, `parseStrictJson`): the JSON.parse grammar, so no NaN or Infinity; integer tokens within ±(2^53−1); no duplicate keys, compared after unescaping; no NUL or lone surrogate in any key or string. Both are tested on the same 36-case table, and the valid cases must equal the plain parse. No existing vector changed its verdict. |
| Checker | `check_consistency.py` needed no change: 0 hard mismatches. Ruby Psych still reads `api/openapi.yaml` as the same value as JSON. |
| Mutation check | 27 mutants on a scratch copy (8 OpenAPI: the `MinuteMs` refs and `multipleOf`, 413 on one operation, the new rate-limit entries and rules; 9 Python and 10 TS strict-parser and linter clauses, including both `contentSchema` hookups), run against the Python tests, `gen-vectors --check` and the TS contract tests: all 27 killed. The description-only items (2–5, 8–10, 12–16 and the lock wording) are not mutation-testable. |

## Revision 16 resync (§0.0p)

Checked first against §0.0p, §4.14, §5.2, §5.4, §5.5 and the server code it cites (`config.py` `RateLimits` and `Settings`, `pipeline.py` `charge`, `ip_key`, `json_content_type`, `read_body`, `take_large_slot`, `ratelimit.py` `hit`, `db.py` `map_exception`, `account_session.py:72`, `__main__.py:35`). The vectors are unchanged, as §0.0p says; their `source` line still names revision 15.

| Item | Contract now |
|---|---|
| 1 | `x-sixkey-rate-limits.limits` gains `proof_valid_account` (account, 60 / 60 s), `device_envelope_bytes` (device, 268435456 / 3600 s, `unit: bytes`) and `account_envelope_bytes` (account, 1073741824 / 3600 s, `unit: bytes`), all `source: m4`, with the scopes of §5.5. The ids and numbers are those of the server's `RateLimits`, which its own contract test reads. |
| 2 | The F8 rule now reads: not subject to `account_writes`, but subject to `proof_valid_account` and `account_envelope_bytes`; an invalid proof never enters `proof_valid_account`. New rules: IP keys count an IPv4 address or an IPv6 /64, IPv4-mapped counts as IPv4; each limiter table holds at most 200000 keys, and a new key past the cap gets 429. |
| 3 | New top-level `x-sixkey-request-rules`, one entry `json_content_type`: Content-Type `application/json`, case-insensitive, the only parameter allowed is `charset=utf-8` (it may be omitted, §5.4); checked before the body is read; 422 `invalid_request`. `info.description` points to the list. |
| 4 | `accountSession`: `aud` must be exactly the string `authenticated` (not a list), and `role` must be `authenticated`. |
| 5 | `unavailable` lists its sources, each with `Retry-After`: 5 s connection wait, 10 s large-body slot wait, 60 s body read, retryable database conflicts, and the auth provider (A23, §5.7; already in the doc). A 503 past uvicorn's `limit_concurrency` comes from the server process without a JSON error body; clients treat any 503 as unavailable. |
| 6 | `reject-all`: the bound is the client-signed `Sixkey-Ts`, so clients sign with the server-corrected time (§4.14). |
| Beyond the list | The first rule ("401 or 403 never count against any quota") now names its one exception, `device_envelope_bytes` (§5.5: failed requests count and are never refunded). A new rule says a `unit: bytes` limit counts request bytes and every other limit counts requests. |
| Linters (both languages) | Rate limits: unique ids, known members only, positive integer limit, window a positive integer or null, `key`, `applies_to` and `section` present, `source` doc or m4, `unit` absent or `bytes`, a byte budget always has a window. Request rules: known members, `applies_to` `with_request_body` or `all`, the code exists with that status, every operation the rule applies to lists that code, `json_content_type` must exist, and every request body is `application/json` only. |
| Tests | Python 36 → 40 and four new TS tests: the three limits and their fields, the reworded and new rules, the malformed-limit and request-rule cases the linters must report, and the texts of items 4–6. |
| Mutation check | 33 mutants on a scratch copy against the Python tests, `gen-vectors --check` and the TS contract tests: 17 in `api/openapi.yaml` (each new value, unit, source and key; each rule; the request rule's code and an operation's 422; the charset, aud/role, 503 and reject-all texts) and 8 per linter (both checks not called, and each new clause): all 33 killed. |

Found while checking the server against §0.0p (M4's to decide; the contract follows the doc). **All four are settled by revision 18**: init pays only `session_envelope_bytes`; budgets count the whole body; a full OTP-verify table is 429; the server's Content-Type check is now exactly §5.4's.
- **init and the byte budgets.** §0.0p and §5.5 count `POST /v1/vault/init` in both byte budgets. `pipeline.charge` charges them only when `self.device is not None`, and init is registration-signed, so init is counted only in `session_writes`.
- **What a byte counts.** The server charges `len(raw)`, the whole request body; §5.5 says envelope bytes. They differ by the rest of the body (proofs, the bundle and, for rotate, the device names), which is small next to an envelope. The contract's rule says "request bytes".
- **The table cap and OTP verify.** `ratelimit.hit` answers a new key past the cap with 429, as written. The per-email OTP-verify counter (`incr`) is a separate table, and at its cap it makes verify answer 401 `otp_invalid`, not 429.
- **charset.** `json_content_type` also accepts `utf8` and a quoted value. §5.4 allows only `charset=utf-8`; the server is slightly more lenient, which is harmless.

## Revision 18 resync (§0.0r)

Checked first against §0.0r, §5.4 and §5.5 and the server code it cites: `config.py` `session_envelope_bytes` (1 GiB / 3600 s), `pipeline.py` `charge` (init pays the session budget by `len(self.raw)`; device and account budgets only on device-signed 9 MiB operations, that is PUT and rotate), `routes/auth.py` `verify` (a full counter table is 429 with `retry_after=60` before the provider call; `authVerify` already lists 429 `rate_limited`), and `json_content_type` (the media type, at most one parameter, exactly `charset=utf-8` after trimming). The A21 server change (enrolling devices out of the account ceiling) was not in `pipeline.py` when this was checked; §0.0r says another agent is making it.

| Item | Contract now |
|---|---|
| 1, 2 | `device_envelope_bytes` and `account_envelope_bytes` no longer name init; their `applies_to` is §0.0r's text verbatim (whole request body, including bodies that fail to parse; never refunded, or refunded on 401/403). |
| 3 | New `session_envelope_bytes` exactly as §0.0r gives it (account session, 1073741824 / 3600 s, bytes, m4, init only). |
| 4, 5 | The bytes rule reads "counts the whole request body's bytes, including a body that does not parse (422 or 413)"; new rule: a body that does not parse carries no valid proof and pays every bucket that applies to it. |
| 6 | Enrolling devices are limited as `enroll:{rid}` and do not count toward `account_reads` or `account_writes` (A21). |
| 7 | The limiter-table rule ends "with Retry-After 60"; `otp_verify_code.applies_to` adds the full-table answer (429, Retry-After 60, provider not asked). |
| 8 | The 401/403 rule keeps its one exception, worded to match item 1: `device_envelope_bytes` keeps what the PUT and rotate requests it applies to used. |
| 9 | `json_content_type.rule` contains §0.0r's sentence verbatim, plus "Clients send application/json (§9 M5)". |
| Linter (both languages) | New: every snake_case name in the rate-limit rules must be a limit id, an error code or a schema property, so a rule cannot name a bucket the table lacks. |
| Tests | Python 40 → 42 and two new TS tests assert each new or changed text exactly. The revision-16 tests that quoted texts revision 18 replaced now check only what still holds, and the full lists of byte limits and `m4` limits include `session_envelope_bytes`. |
| Mutation check | 21 mutants on a scratch copy against the Python tests, `gen-vectors --check` and the TS contract tests: 17 in `api/openapi.yaml` (each changed text, every field of the new limit, each rule, a rule naming a bucket that does not exist, the Content-Type sentence) and 2 per linter for the new name check: all 21 killed. |

## Choices M0 made that need no doc change
- **YAML (N0).** `api/openapi.yaml` is in JSON syntax. Ruby Psych (YAML 1.1) parses it to the same value as JSON; this was checked by hand after each change.
- **Request bodies.** They are strict: unknown members are 422. Responses may grow, and clients ignore unknown members.
- **Hash inputs.**
  - The SAS, CC and verifier inputs are the ASCII tag followed by the raw 32 bytes.
  - SAS and CC are 6-digit zero-padded strings.
  - `rid` is the lowercase hyphenated UUID.
  - §2.2 now states all of this as well.
- **Pinning MUST rules (§3.2).** At M0 these are data vectors: substitutions, the two-session MITM and commitment checks. The adversarial-strategy simulation is M1.

## Not verified here
- M4 (`api/server/`) loads the request schemas from `api/openapi.yaml` and replays the vectors (`docs/design/notes/M4-NOTES.md`); the TS contract tests against `make run` are §9 M5 (A30).
- AES-GCM has only one non-Node check, pyca/cryptography.
- Unicode NFKC was checked on Unicode 16.0 in both runtimes (Node ICU 77.1, Python 3.14). The vectors use long-stable code points only.
