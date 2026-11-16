# M4 notes: the sync API (FastAPI + PostgreSQL + FakeAuthProvider)

Milestone M4 of `docs/SYNC-DESIGN.md`, §9 row M4, tested against §8.4 and §8.5. First written against revision 14; the second round (§9 below) fixes the review `docs/audit/internal-reviews/M4-REVIEW.md` and follows revision 15 (§0.0o) and the contract resynced to it (`api/openapi.yaml`, `contract/vectors/sync-v1.json`, `contract/py`, changed by the contract owner, not here).

- Code: `api/server/` (new files only). Contract, vectors and `contract/py`: read, never edited here.
- The design doc, the contract, the vectors and everything outside `api/server/` were not edited. Where the doc or the contract is ambiguous or wrong, the server follows the doc and the item is listed in [§4](#4-doc--contract-ambiguities-and-decisions) with a proposed fix.
- Nothing is committed (the repository has no commits).

## 1. How to run

Needs Python 3.14 and the PostgreSQL 14+ binaries (`initdb`, `pg_ctl`). Docker is not needed.

```
cd api/server
make venv      # once: .venv with requirements-dev.txt (exact versions)
make check     # = scripts/pg.sh start + the whole suite (about 30-75 s depending on machine load)
```

| Target | What |
|---|---|
| `make pg-start` / `pg-stop` / `pg-reset` | a private cluster in `api/server/.pg/` (unix socket only, no TCP; trust auth on the socket) |
| `make test` | the suite (470 tests) against a fresh, migrated database created for the run and dropped afterwards |
| `make test-long` | the model-based test with 400 programs instead of 40 |
| `make mutants` | the mutation check (§6, 140 mutants), about 50 minutes; `tests/mutation/run_mutants.py --only F01,R10` runs some, `--check` only verifies that every mutant still applies |
| `make contract` | the contract's own Python checks (`contract/py/test_contract.py`) |
| `make run` | migrate `sixkey_dev` and serve `http://127.0.0.1:8787` (the e2e origin) with `SIXKEY_ENV=dev`; FakeAuthProvider OTPs go to `.pg/otp-inbox.jsonl` |
| `make jobs` | the daily job once (`SIXKEY_ENV=dev`) |

`SIXKEY_ENV` must be set explicitly (`dev`, `test` or `production`; S12). With `dev`/`test`, `python -m sixkey_server` refuses a non-loopback `SIXKEY_BIND`; with `production` the app and the job refuse to start until SupabaseAuthProvider exists (M8).

The cluster is started with `log_error_verbosity = terse` (no `DETAIL: Failing row`, §5.6 P7) and, deliberately, `timezone = Asia/Kolkata`: the API's sessions are UTC only because the migration sets `ALTER ROLE sixkey_api SET timezone = 'UTC'` (N4), and the tests check that.

## 2. Environment found

| Item | Found | Used |
|---|---|---|
| OS | macOS (Darwin 27.0), Apple silicon | |
| Python | Homebrew 3.14.6 (also 3.13.12) | 3.14.6 in `api/server/.venv` |
| PostgreSQL | Homebrew `postgresql@14` 14.20 (`/opt/homebrew/bin/initdb`, `pg_ctl`, `psql`); no server running | `scripts/pg.sh` starts a private cluster |
| Docker | CLI 29.8, daemon not running | not used |
| Network | PyPI reachable | packages installed once into the venv |
| Port 8787 | an unrelated program (`mttick-se`) already listens on `*:8787` over IPv6 | `make run` binds `127.0.0.1:8787` (IPv4) without conflict; M5's e2e should make sure it reaches this server, not the other program |
| Packages | none of the needed ones were installed system-wide (only `cryptography` 46) | pinned in `requirements.txt` / `requirements-dev.txt` |

Pinned runtime versions: fastapi 0.141.1, starlette 1.8.0, pydantic 2.14.1, uvicorn 0.54.0, asyncpg 0.32.0, PyJWT 2.15.1, cryptography 50.0.2 (and their exact dependencies). Tests: pytest 9.1.1, pytest-asyncio 1.4.0, hypothesis 6.170.1, httpx 0.28.1. **fastapi is held at 0.141.1** because 0.142+ depends on `opentelemetry-api`, and the API has zero telemetry. A fresh venv from the two files reproduces the dev venv exactly (`pip check` clean).

## 3. What was built

### 3.1 Shape

- `create_app()` (`sixkey_server/main.py`) registers the 29 operations from one table; `tests/test_contract.py` asserts the table equals the contract (operationId, method, path, body limit, signer kind, pw_auth kind).
- One pipeline for every request (`pipeline.py`). First what needs no body (S3): Content-Length over the operation's limit (413; 64 KiB on operations without a body, A9), Content-Type `application/json` on JSON operations (422, S6), the account session, the signer headers' shape and the signer's row (device → 401 unknown_device, enrollment → 410). Then the body (counted while it streams, 413; read within `body_timeout_s`, else 503; the three 9 MiB operations first wait for one of `large_body_slots`, else 503) → signature (device: verify, revoked, ±300 s, P6; enrolling device: `enroll:{rid}`; registration: the body's key) → strict JSON and the operation's **request schema read from `api/openapi.yaml` at startup** → proof evaluation → rate limits → handler → the contract's error body → one log line.
- Request validation uses the contract itself, with the server's own small JSON-Schema-subset validator (`schema.py`, ECMA `$` semantics). At startup it refuses a contract that uses a keyword it does not implement, so no rule can be silently skipped. Responses are validated in the tests with the **independent** validator in `contract/py/sixkey_contract.py`, so the two never share code.
- Test seams in production code: named pause points (`AppState.pause`, a no-op unless a test installs a hook) before the write transactions, after the PUT's device lock, after `complete`'s locks, inside `revoke`, in clear-history (`delete_versions.before_tx`, `.locked`) and before the inserts whose conflicts S8 decides (`init.checked`, `complete.before_insert`, `fork.before_insert`), used for deterministic race tests.
- Keyless checks (`wire.py`): base64 rules (Phase 0 / strict base64url), P-256 SPKI and 65-byte points on the curve, envelope checksum = SHA-256(AAD ‖ iv ‖ ct), head, KeyBundle shape plus the rules the schema cannot express, P4 by iv + wrapped bytes, write proof, verifiers.
- Signatures (`sigauth.py`): configured host, raw target from the ASGI `raw_path` + `query_string` (refused if it contains `|`), P1363 with 0 < r, s < n converted to DER for pyca; high-s signatures are accepted (WebCrypto does not normalize).
- Account session (`account_session.py`): ES256 only, kid from the provider's JWKS, aud, iss, exp/iat against the server clock, sub and session_id UUIDs, not anonymous.
- `AuthProvider` interface + `FakeAuthProvider` (`auth_provider.py`): `send_otp`, `verify_otp`, `revoke_session`, `delete_user`, `purge_unconfirmed`, `jwt_keys`. Each method's docstring names the Supabase call SupabaseAuthProvider (M8) will make. The fake keeps users in a local `auth.users` stub (as the `sixkey_fake_auth` role), codes and sessions in memory; a revoked session's refresh token is dead at once (C1).
- Rate limits (`ratelimit.py`): in-memory sliding windows; IPs, emails, accounts and sessions are only ever `HMAC(daily random key, value)`; the key is replaced at UTC midnight, which drops every counter.
- Retention (`retention.py`): 30 newest + each of the last 30 UTC days' last version, head always kept, 64 MiB cap; inside the PUT / rotate transaction and in the daily job (`jobs.py`: expired enrollments, unconfirmed users older than 24 h, retention).
- Logging (`applog.py`): one JSON line per request with `t` (seconds, UTC), random `rid`, route template, method, status, ms, error code; on 5xx `ref = HMAC(daily key, user_id)[:8]` and the exception class name. Nothing else, ever. uvicorn runs with the access log off and its proxy-header handling off.
- Schema (`migrations/0001_sixkey.sql`): the §5.3 tables with check constraints, `devices_rev`, owner `sixkey_owner` (NOLOGIN), `sixkey_api` with grants and one `USING (true) WITH CHECK (true)` policy per table, RLS on everything, nothing for `anon` / `authenticated` / PUBLIC, `ALTER ROLE sixkey_api SET timezone = 'UTC'`. Idempotent SQL; the runner (`migrate.py`) also records each file's SHA-256 and refuses a changed file. `migrations/local/0000_auth_stub.sql` is the local-only `auth.users` and Supabase roles.

### 3.2 The 29 operations

| # | Operation | Handler | Main tests (every test also schema-checks every response) |
|---|---|---|---|
| 1 | `GET /healthz` | `routes/auth.py: healthz` | test_flows |
| 2 | `POST /v1/auth/otp` | `routes/auth.py: otp` | test_account, test_limits (all four OTP buckets), test_errors (503) |
| 3 | `POST /v1/auth/verify` | `routes/auth.py: verify` | test_account, test_signatures (session revoked at once), test_limits (5 per code, IP) |
| 4 | `GET /v1/account` | `routes/account.py: get_account` | test_account, test_signatures (every JWT failure) |
| 5 | `DELETE /v1/account` | `routes/account.py: delete_account` | test_flows, test_account (F12 failure + retry, cascade), test_signatures (step-up), test_contract (WebCrypto-signed vector replayed) |
| 6 | `POST /v1/vault/init` | `routes/vault.py: init` | test_error_matrix (idempotent retry, vault_exists, concurrent inits), test_signatures (registration rules) |
| 7 | `GET /v1/sync/status` | `routes/vault.py: status` | test_status (read-only, last_seen once a day, devices_rev), test_contract (signed vectors) |
| 8 | `GET /v1/vault` | `routes/vault.py: get_vault` | test_flows, test_cas |
| 9 | `PUT /v1/vault` | `routes/vault.py: put_vault` | test_cas (races), test_status (cursor/forked), test_model, test_limits (8 MiB) |
| 10 | `GET /v1/vault/versions` | `routes/vault.py: list_versions` | test_retention |
| 11 | `DELETE /v1/vault/versions` | `routes/vault.py: delete_versions` | test_retention, test_flows, test_pw_auth |
| 12 | `GET /v1/vault/versions/{v}` | `routes/vault.py: get_version` | test_flows, test_isolation |
| 13 | `GET /v1/keys` | `routes/keys.py: get_keys` | test_flows, test_keys |
| 14 | `PUT /v1/keys` | `routes/keys.py: put_keys` | test_keys, test_model, test_contract (keys_repair and all P4 vector cases through the endpoint) |
| 15 | `POST /v1/keys/rotate` | `routes/keys.py: rotate` | test_keys, test_model, test_contract (rotate_repair vector through the endpoint), test_flows |
| 16 | `GET /v1/devices` | `routes/devices.py: list_devices` | test_flows, test_isolation, test_pw_auth |
| 17 | `POST /v1/devices/fork` | `routes/devices.py: fork` | test_flows, test_contract (WebCrypto-signed fork vector with Sixkey-New-Sig) |
| 18 | `PATCH /v1/devices/{id}` | `routes/devices.py: rename` | test_flows, test_pw_auth, test_status |
| 19 | `POST /v1/devices/{id}/revoke` | `routes/devices.py: revoke` | test_flows, test_cas (revocation vs PUT), test_pw_auth |
| 20 | `POST /v1/enroll/requests` | `routes/enroll.py: create` | test_enroll |
| 21 | `GET /v1/enroll/requests` | `routes/enroll.py: list_requests` | test_enroll |
| 22 | `GET /v1/enroll/requests/{rid}` | `routes/enroll.py: get_request` | test_enroll (F-10 fields by state), test_contract (signed vector) |
| 23 | `POST …/{rid}/respond` | `routes/enroll.py: respond` | test_enroll (single approver, handled_by, P6) |
| 24 | `POST …/{rid}/reveal` | `routes/enroll.py: reveal` | test_enroll |
| 25 | `POST …/{rid}/approve` | `routes/enroll.py: approve` | test_enroll, test_contract (key_mismatch vector) |
| 26 | `POST …/{rid}/complete` | `routes/enroll.py: complete` | test_enroll (idempotent, too_many_devices, name rules) |
| 27 | `POST …/{rid}/reject` | `routes/enroll.py: reject` | test_enroll, test_pw_auth |
| 28 | `POST /v1/enroll/reject-all` | `routes/enroll.py: reject_all` | test_enroll, test_pw_auth |
| 29 | `POST /v1/enroll/recovery` | `routes/enroll.py: recovery` | test_enroll, test_limits |

`tests/test_error_matrix.py` drives unknown_device, bad_signature, clock_skew, device_revoked and rate_limited through every operation the contract lists them for; `tests/test_zz_coverage.py` then asserts (on a full run) that all 29 operations answered with a 2xx and that every (operation, status, code) of `x-sixkey-errors` was observed or is documented unreachable.

### 3.3 Error codes

| Code | Raised in | Tests |
|---|---|---|
| invalid_email | `routes/auth.py: otp` | test_account |
| invalid_request | `pipeline.parse`, `wire.*`, handlers' consistency checks | test_keys, test_cas, test_enroll, test_contract (wire counterexamples) |
| otp_invalid | `routes/auth.py: verify` | test_account, test_limits |
| session_invalid | `account_session.verify`; FK violation on a deleted auth user | test_signatures, test_account |
| step_up_required | `routes/account.py` | test_signatures |
| bad_signature | `pipeline.auth_*`, `routes/devices.py: fork` (New-Sig) | test_signatures, test_error_matrix, test_contract |
| unknown_device | `pipeline.auth_device` | test_signatures, test_error_matrix |
| clock_skew | `pipeline._check_window` | test_signatures (edges ±300 000 / ±300 001 ms), test_error_matrix |
| device_revoked | `pipeline.auth_device`; in-transaction re-check `routes/common.lock_signer` | test_signatures, test_cas, test_error_matrix |
| write_denied | PUT, rotate | test_cas, test_keys, test_model |
| password_mismatch / recovery_mismatch | `Ctx.enforce_proof`; recovery enrollment | test_pw_auth, test_keys, test_enroll |
| no_vault | enrollment create / recovery (reachable); device-signed reads (unreachable, §4 A28) | test_enroll |
| not_found | versions/{v}, devices/{id}, unknown routes | test_flows, test_isolation, test_errors |
| vault_exists / device_exists | init, enrollment create, recovery, fork | test_error_matrix, test_enroll, test_isolation |
| version_conflict / vk_mismatch / keys_conflict | PUT, PUT keys, rotate | test_cas, test_keys, test_model |
| one_per_session | enrollment create / recovery (unique index) | test_enroll |
| enroll_state / enroll_gone | enrollment handlers | test_enroll |
| too_many_devices | complete, fork | test_enroll |
| too_large | `pipeline.read_body`, envelope size | test_limits, test_keys |
| key_mismatch | approve | test_enroll, test_contract |
| rate_limited | `Ctx.charge`, OTP / recovery buckets, invalid-proof bucket | test_limits, test_pw_auth, test_error_matrix |
| internal_error / unavailable | `db.map_exception` (503 for connection errors, pool-acquire timeout, deadlock, serialization failure), provider errors, body timeout, no large-body slot | test_errors, test_account (fault injection), test_review (S3, S7, S10) |

## 4. Doc / contract ambiguities and decisions

Each item: what the doc or contract says, what the server does, and a proposed fix.

**Status (revision 15, §0.0o):** every item is decided. A1, A3–A24 and A27 are accepted as the server does them (A2 with no cache and the reject-all bound, §9.3; A16 keeps `enroll_state`; A22 with the attempt taken before the provider, S1); A25 and A29 unchanged; A26 is M8 checklist item 6; A28 is kept as a defence; A30 moved to §9 M5. The contract was resynced (413 everywhere, `MinuteMs`, the new rate-limit ids, the reject-all wording, strict nested texts), and the server passes against it.

| # | Where | Issue | Server does | Proposed fix |
|---|---|---|---|---|
| A1 | §5.3 (PUT SQL), C3; §5.3 rotate; no lock order anywhere | `SELECT … FOR SHARE` on the device row, then the same transaction updates that row (`cursor` in PUT; names in rotate; `auth_failures`). Two transactions holding FOR SHARE that both update the row deadlock: two clones of one identity PUTting at once. Postgres aborts one (`DeadlockDetectedError` after `deadlock_timeout`, a 500; mutant M35, checked by hand). The doc also fixes no lock order between device, vault and enrollment rows, and its natural orders conflict (complete: request → vault; rotate: vault → requests; revoke: requests → vault). | Device rows are locked `FOR NO KEY UPDATE` (still serializes every write with a revocation, C3's purpose). **One lock order everywhere: device rows (by device_id) → the vault row → enrollment rows (by request_id, `delete_enrollments`)**; vault_versions rows are only touched while the vault row is held. So rotate locks all of the account's device rows before its CAS, `complete` locks the vault row before its request, `revoke` takes the vault row before it voids the approver's requests, and multi-row request deletes lock in request_id order. Deterministic interleaving tests for PUT×PUT, rotate×PUT, complete×rotate and revoke×complete (pause points); mutants M35, M39, M44, M45 restore the old orders and die with `DeadlockDetectedError`. Residual: deleting the account (one auth-user delete, cascade order chosen by Postgres) racing another device's write can deadlock; nothing is half-done, and since the second round the server answers 503 + Retry-After and retries the deletion once (S7, §9). | §5.3: "FOR NO KEY UPDATE; lock order: device rows (by id), the vault row, enrollment rows (by id)". |
| A2 | §5.2 "不需要 nonce 缓存", contract `no_nonce_cache`; the M4 brief asks for "replay protection" | The doc decides against a nonce cache. | No cache (decided, revision 15). Replays inside the window hit CAS / byte-identical idempotency / one-shot states; tests replay PUT (409), PUT keys (200, unchanged), revoke (same revoked_at), reject (410), init (201, unchanged); outside the window: clock_skew. `reject-all` deletes only requests created at or before the minute of its signed `Sixkey-Ts`. The six residual replays are listed in §9.3 for the design owner, each with a test. | Done in revision 15 (§1.2 A6, §5.2, §10 #93). |
| A3 | §5.3 `enrollments` | No column for the approve step's `name_ct` (the K_name ciphertext that becomes `devices.name_ct` at complete). `new_name_ct` holds reveal's K_enroll ciphertext, which the approver view must keep returning in state approved (F-10), so it cannot be overwritten. | Added `enrollments.name_ct text`. | Add the column to §5.3. |
| A4 | §5.4 响应 vs `ErrorBody` | §5.4 says clock_skew's `server_time` is "in error"; `ErrorBody.error` has `additionalProperties: false` without it. | Top-level `server_time` only (it is in every body). | §5.4: "clock_skew: the top-level server_time". |
| A5 | §3.6.0, §5.3 | The order of the idempotent check is not written down. A byte-identical replay after a password change carries the replaced state's pw_auth (now wrong), and P4 against the identical stored bundle demands "no verifier", so a check-proofs-first server could never answer the promised 200. | PUT /v1/keys and rotate: shape + kver range (422) → identical stored text = 200 → CAS preconditions (409) → write proof (rotate, 403) → pw_auth / recovery_auth (403, counted) → vaultId / vkId / by / P4 (422) → transaction. The 409 comes before the proof so an honest race is not counted as a wrong password. The idempotent 200 changes nothing and reveals only what `GET /v1/keys` returns. | Write the order into §5.3. |
| A6 | §3.8 P3, §5.4 rotate `device_names` | Completeness of `device_names` is not specified. | Each id must be a device of the account (else 422), no duplicates, each `name_ct.vkId` = the new VK; devices not listed keep their old name_ct (a device that completed concurrently, client re-lists). | State it in §5.4. |
| A7 | §3.8 | Rotate with both `if_version` and `if_kver` stale. | `keys_conflict` (a key race voids the rotation, §3.8 P3) before `version_conflict`. | State it. |
| A8 | contract `EnvelopeText.maxLength` vs §4.3 | maxLength counts code points; an over-8 MiB ASCII envelope fails the schema (422) before the byte check (413). | Envelope bytes are checked before the schema: 413 too_large. | Contract note on EnvelopeText. |
| A9 | contract: GET operations | Bodyless operations list no 413, but a client can still send a body. | Every request body is capped at 64 KiB (413 beyond); a body on a GET is hashed into the signing input like any body. | List 413 for every operation, or define "body on a bodyless operation → 401 bad_signature". |
| A10 | §3.14 S2, rate-limit rules | "桶满后直接拒绝" gives no code for the invalid-proof bucket. | 429 rate_limited + Retry-After, no database write. | State it. |
| A11 | §3.14 | A missing proof where the schema allows it (device-side reject). | 403 password_mismatch, not counted (no guess was made); elsewhere the schema requires the field (422). | State it. |
| A12 | §5.3 N15 | The list of devices_rev triggers names the auth_failures increase, not the reset. | A reset (valid proof after failures) bumps devices_rev too, so other devices drop the banner. Cursor writes and last_seen_at do not. | Add "reset" to N15's list. |
| A13 | C14 vs contract `EnrollCreateResponse.expires_at: Ms` | An exact `expires_at = now + 600 s` reveals the exact creation time that C14 keeps at minute precision. | `expires_at` = (now + 600 s) rounded **up** to the minute (stored and returned): minute precision, lifetime in [10, 11) minutes. | Contract: `MinuteMs`, §3.2 "about 10 minutes". |
| A14 | §3.2, §5.4 status / list | `pending_enrollments` and the list's scope are not exact; recovery requests have none of the approver view's required fields (commit, approver_*). | `pending_enrollments` = approval requests in state pending, unexpired. The list shows approval requests in every state (handled_by once responded). Recovery requests are never listed or polled (GET → 410). `reject-all` deletes every open request including recovery ones ("every open request of this account"); `rejected` counts the unexpired ones. | State it. |
| A15 | §3.2 | Retries of individual steps. | Identical respond (same approver, same epk) and identical reveal → 200; different values → 409 enroll_state. A repeated approve → 409 (MUST 8 polling covers a lost 200). | State it. |
| A16 | §5.4 complete | `device_exists` is not listed for complete; the new device id can be taken between create and complete (another account's init, a fork). Approval path with a `name_ct` in the body; recovery path without one. | Same id + same key in this account → 200 (D4); taken otherwise → 409 enroll_state (the request survives). Approval path + name_ct → 422; recovery path without name_ct → device with a null name. | List device_exists for complete, or keep enroll_state. |
| A17 | §5.3 D4 complete | "complete 按原文幂等": the request is deleted by the first complete, so a retry of the same rid cannot even be authenticated (its key lives in the deleted row). | A retry of the same rid → 410; the client's D4 path (status query signed with devN → 200) is the recovery. The idempotent 200 applies to a second request for the same device (two sessions). | §3.2 M7 wording. |
| A18 | §2.3 N20 | Strictness beyond numbers. | 422 also for duplicate object keys, NUL characters and lone surrogates in any string, in bodies, bundles and envelopes; the integer-token rule also applies to the envelope text. | State it. |
| A19 | §2.4, §5.4 | Which VK a `name_ct` must be under. | `name_ct.vkId` = the account's current vk_id (init: the envelope's; rotate: the new one) for init, approve, complete, rename, fork; else 422. | State it. |
| A20 | §5.2 | Signer headers on `device_or_enroll` endpoints; `Sixkey-Enroll` vs the path. | Exactly one of Sixkey-Device / Sixkey-Enroll, and Sixkey-Enroll must equal the path rid; otherwise bad_signature. `sub` in the signing input is the JWT sub only on operations that carry an account session (registration, DELETE /v1/account). | State it. |
| A21 | §5.5 | No limits are listed for GET /v1/account, init and enrollment create. | A per-session bucket (30 writes / 60 reads per minute, configurable). Enrolling devices are limited like a device keyed by `enroll:{rid}`; since revision 18 (§0.0r, §12 here) they do **not** count toward the account ceiling. | Added to §5.5 (rev 15, 18). |
| A22 | §5.5 OTP verify | "每验证码 5 次" without the server knowing the code. | Per email (HMAC'd): after 5 wrong attempts every verify for that email is otp_invalid until a new code is sent. A malformed email on verify → otp_invalid (400 is not listed there). | State it. |
| A23 | §5.2 C1 | What if the immediate logout fails. | 503 (fail closed; the code is spent, the user asks for a new one). | State it. |
| A24 | §5.8 | "最近 30 天内每个 UTC 日的最后一个版本"; 64 MiB order once only day-lasts remain. | Today and the 29 previous UTC days. Cap: oldest non-day-last first, then oldest day-lasts, never the head. History includes version 1 from init. | State it. |
| A25 | §5.2 / contract `deviceSignature` order | The signing input's host for e2e. | `SIXKEY_API_ORIGIN` → `URL.host` (lowercase, port only when non-default); the Host header is ignored (tested over TCP too). | — |
| A26 | §5.3 C2, M8 | `GRANT REFERENCES ON auth.users TO sixkey_owner` and `GRANT sixkey_owner TO CURRENT_USER` are in the migration; on Supabase `auth.users` is owned by `supabase_auth_admin`. | Works locally. | M8: verify the grant (or have the auth admin run it); give `sixkey_api` a password outside the migration. |
| A27 | §5.1 layout | §5.1 names `api/app/…` and `supabase/migrations/`; M4 had to stay in `api/server/`. | Package `api/server/sixkey_server`, migration in `api/server/migrations/`. | M8 copies `0001_sixkey.sql` to `supabase/migrations/`. |
| A28 | §5.4 404 no_vault on device-signed reads | A device row exists only with its vault (both inserted in one transaction; only the auth-user cascade removes them, together). | The code path exists; the 9 (operation, no_vault) pairs are documented unreachable in `test_zz_coverage.py`. | Drop no_vault from the device-signed operations, or keep as defensive. |
| A29 | §5.2 oracles | `unknown_device` (401) vs `bad_signature` reveals whether a device id exists; an unknown rid is 410 before any signature check. | As the doc orders it. Ids are 128-bit / UUIDv4 random; nothing practical leaks. | — |
| A30 | §8.5 | "The same TS contract tests against FakeServer and the real FastAPI": the TS FakeServer is M3 and not written. | Python contract tests run against the real app (every response validated; vectors replayed byte for byte). | M3/M5 point the TS contract tests at `make run`. |

## 5. Tests

`make check`: **470 tests, all passing** against the revision-18 contract (first round: 336; second round: 450; third: 469), 30-75 s depending on machine load, plus Hypothesis' 40 programs inside one test (400 with `make test-long`). The database is a fresh one per run, migrated from scratch, and dropped afterwards. `make contract` (the contract's own checks, 42/42) and `contract/tools/check_consistency.py` (0 hard mismatches) pass too.

| File | Tests | Covers |
|---|---|---|
| test_contract.py | 58 | operations/errors/constants/limits = contract; wire examples and counterexamples through the server validator; every vector group the server touches (number tokens, bundle shapes, envelope, write proof, verifiers, public keys, request and fork signatures incl. the pure-Python ECDSA oracle, kver rules); WebCrypto-signed vector requests replayed byte for byte (status, query target, e2e host, enrollment poll, DELETE /v1/account, fork with Sixkey-New-Sig); keys_repair, all P4 cases and rotate_repair through the real endpoints |
| test_cas.py | 12 | 20 concurrent PUTs (1 winner), 8 writers converging (strictly consecutive versions, every accepted write stored once, head, history_bytes), clones without deadlock, two deterministic lock interleavings (A1: same identity after the device lock; rotate vs a PUT holding a device row), replay = 409, vk_mismatch vs write_denied, keyless envelope checks, revocation committed mid-PUT (deterministic pause hook), a writer racing revocation, two app instances on one database, head across a rollback (D5) |
| test_keys.py | 36 | kver range edges (+65 536 ok, +65 537 422), stale if_kver, byte-identical replay (any if_kver, after a password change, not counted), concurrent key changes, every P4 rule, createdAt/extra members are not a change, vaultId/vkId/by consistency, hour alignment, non-integer tokens and duplicate keys, forward-compatible bundle members, the recovery_auth path, rotate conflicts / atomic refusals / 8 MiB / racing a PUT |
| test_signatures.py | 29 | every tampered field, dropped DELETE body (N25), Host ignored and raw target, '|' in the target (raw ASGI), window edges, malformed headers incl. DER and r/s bounds, high-s, unknown/revoked/foreign devices (verify before revoked), registration rules, enroll signer = path rid, replays inside and outside the window; every JWT failure incl. alg none and HS256 key confusion, 900 s lifetime, immediate session revocation, step-up |
| test_enroll.py | 21 | lock-order interleavings complete×rotate and revoke×complete (A1), illegal transitions, one approver + handled_by, identical retries, expired-not-deleted requests cannot advance at any step (P6), minute precision, one per session (incl. recovery), no_vault/device_exists, F-10 view fields, invalid keys, rejects, reject-all, revoked approver, complete idempotent + too_many_devices, recovery path |
| test_pw_auth.py | 31 | every pw endpoint × (wrong, missing) incl. self-revoke/self-rename/device reject/clear history; per-device counter capped at 10, never locking, devices_rev on change; concurrent failures exact; the invalid-proof bucket stops writes; a copy cannot crowd out revocation and rotation; 401/403 not counted |
| test_isolation.py | 2 | tenant A aims every operation at tenant B's ids (versions, devices, requests, enrolling signer, fork/init/enrollment ids, B's vault id, B's bundle, B's device in rotate names, B's session for deletion); B's rows in every table unchanged and nothing of B's in any response; 409 bodies carry only the caller's state |
| test_limits.py | 44 | body limits of all 21 body operations (limit ok, limit + 1 and chunked → 413) and the 64 KiB cap on the 8 bodyless ones plus healthz (A9), an unauthenticated body is not read (S3), 8 MiB envelope, the session buckets (A21), enrolling devices bounded by their own `enroll:{rid}` buckets, one request per session and the OTP sends, and never counting toward the owner's account ceiling (rev 18), device/account limits with the contract's numbers, account ceiling sparing revocation, all OTP buckets, verify per code, recovery limits, no IP/email in limiter keys and the daily key, X-Forwarded-For only from a trusted proxy, CORS never deciding anything |
| test_error_matrix.py | 56 | the generic errors per operation; vault_exists and init idempotency; concurrent inits |
| test_db_roles.py | 11 | sixkey_api is not super/bypassrls and has no DDL/TRUNCATE/auth access, no CREATE in any schema (public included) and no TEMP/CREATE on the database (S11); anon/authenticated/PUBLIC see nothing; RLS on, policies exact, removing the policy hides everything; owner cannot log in; the cascade through RLS; UTC sessions on a +05:30 cluster; every stored and returned time at hour/day/minute |
| test_migrations.py | 4 | 0002's post-condition raises when its revokes had no effect (§11); from scratch, again (recorded), raw SQL twice more with an identical catalog; changed file refused; doc columns, no IP/UA/revoked_by columns |
| test_retention.py | 6 | 45 days of random writes against an independent model, the byte cap, the real 64 MiB with 8 MiB envelopes, the daily job (aging days, expired enrollments, unconfirmed users at 24 h), clear history |
| test_status.py | 4 | status writes nothing (rows and xmin), last_seen once per UTC day, cursor/forked cases, devices_rev step by step, min_client_version |
| test_account.py | 20 | OTP 202 for any address, invalid emails, malformed bodies, verify single use, account reads, failed auth delete deletes nothing and can be retried, other devices then get unknown_device |
| test_errors.py | 6 | driver errors → 500 without details, database down → 503 + Retry-After, provider down → 503, a failing step rolls the transaction back, unknown routes, errors never echo input |
| test_model.py | 1 (40 programs) | Hypothesis programs of PUT / PUT keys / rotate (fresh, stale, replayed, wrong proofs, out-of-range kver) and concurrent PUT pairs vs a reference model, checking responses and the database after every step; `make test-long` runs 400 |
| test_flows.py | 8 | happy paths through all operations; no conditional GET (N2) |
| test_uvicorn.py | 1 | real TCP: raw targets from uvicorn, configured host only, Date on 204, chunked 413, no server header |
| test_review.py | 104 | the review's regressions, in this suite's style (§9.4): T1 credential matrices, S1 concurrent guesses with a slow provider, S2/S4 buckets and byte budgets, S3 slots and stalled bodies, S5 /64 and memory bounds, S6 Content-Type matrix, S7 deletion race and bounded retry, S8 deterministic races with a Postgres-log check, S10 pool exhaustion, S12 environment rules, T2 races, T3, I2 exact claims, the two text oracles agreeing (S14), the reject-all bound and the six replay residuals |
| test_rereview.py | 10 | the re-review's nine probes (§11.2): RR1 byte budgets on unparsable rotates and init's per-session budget, RR3 a full counter table is 429, and the pinned residuals RR2, RR3b, RR6, P7, P8 |
| test_zz_coverage.py | 3 | all 29 operations succeeded; every listed (operation, status, code) seen or documented unreachable; every error code seen |
| test_zz_logs.py | 3 | every server-side log record of the session and the Postgres log: no IPs (incl. forged X-Forwarded-For), emails, OTPs, tokens, header values, ids, long base64, secrets of any kind, `DETAIL`/`Failing row`; request lines only the allowed fields at second precision |

Bugs the suite found while it was written (all fixed): an asyncpg parameter typed both int and bigint in init (500); the FakeAuthProvider letting PyJWT compare iat with the wall clock (500 under a fake clock); a configured rate limit of 0 indexing an empty window (500); an oversized envelope answered 422 instead of 413.

## 6. Mutation check

`make mutants` (`tests/mutation/run_mutants.py`, mutants in `tests/mutation/mutants.py`): each mutant is one or more exact, single-occurrence replacements in a **scratch copy** of `sixkey_server/` and `migrations/` (the repository is never modified); the whole suite then runs with `-x` against the local Postgres, one mutant at a time (the suite shares the cluster's roles and its log). **Third round: 139 mutants, 139 killed** (the 45 of the first round, the first reviewer's 32, 54 for the second-round fixes and the revision-15 contract, 8 for the re-review), about 51 minutes, on the final code. "Killed by" is the first failure under `-x` in collection order, so it is not always the test aimed at the rule (F02 and F12, for example, are also killed by their own tests when run alone).

- **First round** (45 mutants): one survivor, M35 (the device-row lock as §5.3 wrote it, `FOR SHARE`), killed after a pause point (`put_vault.locked`) made the clone deadlock deterministic; that is the evidence behind A1. M39, M44 and M45 check the rest of the lock order the same way.
- **The first reviewer's 32** (R01–R32) had 8 survivors on the first-round code (R01, R07, R09, R10, R11, R16, R24, R26: findings T1–T3). All are killed now. R01, R21 and R27 were re-targeted at the restructured pipeline (same bug, new location); the other 29 apply verbatim.
- **Re-targeted at changed code:** M20 (revoked before the signature: now planted in the bodiless device lookup), M28 and F01 (the reserve-first counter and its 429 on a full table), F23 and F24 (the exact Content-Type rule).
- **M37 became equivalent and was strengthened.** The I2 fix added an exact `aud == "authenticated"` check after PyJWT's own audience check, so removing only PyJWT's check (the old M37) changed nothing observable and survived one full run. M37 now removes both, which is the bug it names; F46 removes only the exact check (an audience list then passes PyJWT). Both are killed.
- **The re-review's surviving mutant** (its X18: `X-Forwarded-For` by its leftmost value) is F55, killed by the multi-value test.
- **Hangs:** the second round's claim "no mutant hung" held only for full `-x` runs: F12 run against the slot test alone waited forever (§11.1). Every wait on a pause point now has a 10 s timeout, and a per-test watchdog in `conftest.py` turns any other hang into a failed run with the hung test's id and stacks (120 s per test in the runner). In this run no mutant reached the watchdog or the runner's own 1800 s limit.

| # | mutant | result | killed by (first failing test) |
|---|---|---|---|
| M01 | CAS without the version check (only the pre-check remains) | killed | tests/test_cas.py::test_twenty_concurrent_puts_same_if_version_exactly_one_wins |
| M02 | history row written outside the vault transaction | killed | tests/test_cas.py::test_twenty_concurrent_puts_same_if_version_exactly_one_wins |
| M03 | tenant filter missing on GET /v1/vault/versions/{v} | killed | tests/test_isolation.py::test_user_a_can_never_read_or_modify_user_b |
| M04 | tenant filter missing when locking/looking up target devices | killed | tests/test_isolation.py::test_user_a_can_never_read_or_modify_user_b |
| M05 | signature not verified on the enrolling-device endpoints | killed | tests/test_error_matrix.py::test_generic_enroll_signature_errors[getEnrollRequest] |
| M06 | timestamp window off by one (>= instead of >) | killed | tests/test_rereview.py::test_reject_all_signed_by_a_fast_clock_reaches_requests_opened_after_it |
| M07 | idempotent replay of PUT /v1/keys compares only kver, not the text | killed | tests/test_keys.py::test_same_kver_different_text_after_progress_is_a_conflict |
| M08 | pw_auth failure counter account-wide | killed | tests/test_pw_auth.py::test_failure_counter_is_per_device_capped_and_never_locks |
| M09 | client IP logged | killed | tests/test_zz_logs.py::test_server_logs_hold_nothing_sensitive |
| M10 | retention keeps the oldest 30 instead of the newest 30 | killed | tests/test_retention.py::test_retention_over_45_days |
| M11 | write proof not checked on PUT /v1/vault | killed | tests/test_cas.py::test_vk_mismatch_and_write_denied_are_distinguished |
| M12 | kver jump bound missing | killed | tests/test_contract.py::test_kver_rule_vectors |
| M13 | 409 version_conflict body built from another tenant's row | killed | tests/test_isolation.py::test_conflict_bodies_carry_only_the_callers_state |
| M14 | PUT transaction without the device-row lock and revoked re-check (C3) | killed | tests/test_cas.py::test_two_puts_of_one_identity_interleaved_after_the_device_lock |
| M15 | respond advances an expired request (P6) | killed | tests/test_enroll.py::test_expired_but_not_deleted_requests_cannot_advance[respond] |
| M16 | a second approver may respond | killed | tests/test_enroll.py::test_one_approver_only_and_handled_by |
| M17 | approve does not check sig_pubkey_sha256 | killed | tests/test_contract.py::test_approve_checks_sig_pubkey_sha256_like_the_vector |
| M18 | P4 only checks password wrap vs auth | killed | tests/test_contract.py::test_p4_vector_cases_through_put_keys[password and recovery wraps changed, aut] |
| M19 | bundle.by not compared with the signer | killed | tests/test_keys.py::test_bundle_consistency_with_the_account[by] |
| M20 | revoked answered before the signature is verified (P6), at the bodiless device lookup | killed | tests/test_signatures.py::test_unknown_revoked_and_foreign_devices |
| M21 | invalid-proof bucket missing (every flood writes the database) | killed | tests/test_pw_auth.py::test_invalid_proof_flood_stops_at_the_bucket_without_writes |
| M22 | a valid pw_auth is not exempt from the per-device limits | killed | tests/test_pw_auth.py::test_a_copy_cannot_crowd_out_revocation_and_rotation |
| M23 | 401/403 responses are counted against the quotas | killed | tests/test_pw_auth.py::test_401_and_403_are_not_counted_against_quotas |
| M24 | status writes last_seen_at on every poll | killed | tests/test_status.py::test_status_writes_nothing_but_last_seen_once_a_day |
| M25 | rename does not bump devices_rev | killed | tests/test_status.py::test_devices_rev_moves_exactly_on_device_changes |
| M26 | clone detection reports a lost-200 retry as forked | killed | tests/test_status.py::test_cursor_and_forked |
| M27 | daily window one day too long | killed | tests/test_retention.py::test_retention_over_45_days |
| M28 | no per-code limit on OTP verification | killed | tests/test_limits.py::test_otp_verify_five_attempts_per_code |
| M29 | Supabase session not revoked after verify (C1) | killed | tests/test_signatures.py::test_verify_revokes_the_session_at_once |
| M30 | step-up does not check iat | killed | tests/test_signatures.py::test_step_up_for_account_deletion |
| M31 | init idempotency ignores the bundle text | killed | tests/test_error_matrix.py::test_init_vault_exists_and_idempotent_retry |
| M32 | rotate does not void open enrollments | killed | tests/test_flows.py::test_rotate_then_put |
| M33 | target containing ' | ' accepted | killed |
| M34 | signing input uses the Host header | killed | tests/test_contract.py::test_presigned_status_requests_replayed_into_the_server |
| M35 | device rows locked FOR SHARE as §5.3 writes it (deadlock between clones) | killed | tests/test_cas.py::test_two_puts_of_one_identity_interleaved_after_the_device_lock |
| M36 | an oversized envelope is 422 instead of 413 | killed | tests/test_limits.py::test_envelope_over_8_mib_in_a_9_mib_body_is_too_large |
| M37 | account session accepts any audience (both the PyJWT check and the exact-claim check, I2) | killed | tests/test_review.py::test_session_claims_are_exact[over0] |
| M38 | non-integer number tokens accepted | killed | tests/test_cas.py::test_envelope_keyless_checks |
| M39 | rotate locks only the signer's device row (lock order) | killed | tests/test_cas.py::test_rotate_waits_for_a_put_holding_a_device_lock |
| M40 | rate-limit keys hold the raw IP / email | killed | tests/test_limits.py::test_rate_limit_keys_hold_no_ip_or_email |
| M41 | the daily key is never replaced | killed | tests/test_limits.py::test_rate_limit_keys_hold_no_ip_or_email |
| M42 | P4 counts a createdAt-only difference as a changed wrap | killed | tests/test_contract.py::test_p4_vector_cases_through_put_keys[both wraps differ only in createdAt (tru] |
| M43 | enrollment expires_at kept at millisecond precision | killed | tests/test_contract.py::test_approve_checks_sig_pubkey_sha256_like_the_vector |
| M44 | complete locks the request before the vault row (deadlocks with rotate) | killed | tests/test_enroll.py::test_complete_and_rotate_interleaved_do_not_deadlock |
| M45 | revoke voids requests before taking the vault row (deadlocks with complete) | killed | tests/test_enroll.py::test_revoke_and_complete_interleaved_do_not_deadlock |
| R01 | device-signed GETs also accept a bare account session (weaker credential) | killed | tests/test_review.py::test_a_bare_account_session_never_replaces_a_signature[getSyncStatus] |
| R02 | tenant filter missing in DELETE /v1/vault/versions | killed | tests/test_isolation.py::test_user_a_can_never_read_or_modify_user_b |
| R03 | tenant filter missing in GET /v1/vault/versions | killed | tests/test_isolation.py::test_user_a_can_never_read_or_modify_user_b |
| R04 | PUT /v1/keys CAS on 'stored kver < new kver' (stale if_kver accepted) | killed | tests/test_keys.py::test_stale_if_kver_is_keys_conflict_and_changes_nothing |
| R05 | kver jump bound off by one (exclusive upper bound) | killed | tests/test_contract.py::test_kver_rule_vectors |
| R06 | kver jump bound off by one (one too many) | killed | tests/test_contract.py::test_kver_rule_vectors |
| R07 | idempotent comparison ignores the tail of the text (the mac) | killed | tests/test_review.py::test_idempotency_is_byte_for_byte_not_by_kver[mac] |
| R08 | a valid proof on one device clears every device's failure counter | killed | tests/test_pw_auth.py::test_failure_counter_is_per_device_capped_and_never_locks |
| R09 | byte cap may drop the head | killed | tests/test_review.py::test_the_byte_cap_never_drops_the_head |
| R10 | clear-history without the device lock / vault FOR UPDATE (races a PUT, revoked not re-checked) | killed | tests/test_review.py::test_clear_history_racing_a_revocation |
| R11 | PUT /v1/keys without the in-transaction device lock / revoked re-check (C3) | killed | tests/test_review.py::test_put_keys_racing_a_revocation |
| R12 | every 4xx except 429 is refunded (409/422 floods uncounted) | killed | tests/test_limits.py::test_device_write_and_read_limits |
| R13 | timestamp window one-sided (any past ts accepted) | killed | tests/test_error_matrix.py::test_generic_device_signature_errors[deleteAccount] |
| R14 | JWT alg none accepted (signature skipped) in the session path | killed | tests/test_signatures.py::test_account_session_checks |
| R15 | CORS reflects any Origin | killed | tests/test_limits.py::test_cors_never_decides_anything |
| R16 | log line carries a header value (User-Agent) | killed | tests/test_zz_logs.py::test_request_lines_have_only_the_allowed_fields_at_second_precision |
| R17 | any device of the account may approve (not only the responder) | killed | tests/test_enroll.py::test_one_approver_only_and_handled_by |
| R18 | complete ignores expiry | killed | tests/test_enroll.py::test_expired_but_not_deleted_requests_cannot_advance[complete] |
| R19 | reveal can be re-done with other values (SAS re-roll) | killed | tests/test_enroll.py::test_identical_retries_of_respond_and_reveal |
| R20 | device cap off by one in complete | killed | tests/test_enroll.py::test_complete_idempotent_and_too_many_devices |
| R21 | a revoked device can still read (GET) | killed | tests/test_error_matrix.py::test_generic_device_signature_errors[getSyncStatus] |
| R22 | X-Forwarded-For believed from any peer | killed | tests/test_limits.py::test_forwarded_for_only_from_a_trusted_proxy |
| R23 | recovery (account, IP) bucket refunded on 403 (unlimited code guessing per IP) | killed | tests/test_limits.py::test_recovery_limits |
| R24 | rotate CAS without kver (lost update vs a concurrent PUT /v1/keys) | killed | tests/test_review.py::test_rotate_racing_a_put_keys_loses_the_kver_cas |
| R25 | fork verifies Sixkey-New-Sig with the OLD key (no proof of possession of the new key) | killed | tests/test_contract.py::test_presigned_fork_replayed |
| R26 | rotate does not compare bundle.by with the signer | killed | tests/test_review.py::test_rotate_compares_by_with_the_signer |
| R27 | body limit only from Content-Length (a chunked body is never capped) | killed | tests/test_limits.py::test_body_limit_per_endpoint[authOtp] |
| R28 | PUT history rows stored at millisecond precision | killed | tests/test_db_roles.py::test_every_written_time_is_utc_hour_day_or_minute |
| R29 | enrolling signer not bound to the path rid | killed | tests/test_signatures.py::test_enroll_signer_must_match_the_path |
| R30 | fork device cap off by one | killed | tests/test_enroll.py::test_complete_idempotent_and_too_many_devices |
| R31 | write proof checked against if_version - 1 tolerance (stale proof replay) | killed | tests/test_contract.py::test_write_proof_vectors |
| R32 | pw failure counter not capped (unbounded WAL writes) | killed | tests/test_pw_auth.py::test_failure_counter_is_per_device_capped_and_never_locks |
| F01 | S1: OTP attempt counted only after the provider answered (check-then-act) | killed | tests/test_rereview.py::test_a_full_counter_table_answers_429_on_verify |
| F02 | S1/A22: a new code does not reset the email's attempts | killed | tests/test_cas.py::test_twenty_concurrent_puts_same_if_version_exactly_one_wins |
| F03 | S13: trailing-slash redirect built from the Host header | killed | tests/test_review.py::test_trailing_slash_is_404_not_a_host_built_redirect[/v1/vault/] |
| F04 | S2: no per-account bucket for valid-proof requests | killed | tests/test_review.py::test_valid_proof_requests_are_bounded_per_account |
| F05 | S4: no per-device envelope byte budget | killed | tests/test_rereview.py::test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets |
| F06 | S4: the device byte budget is refunded on 403 (write_denied floods are free again) | killed | tests/test_review.py::test_failing_envelope_writes_pay_the_device_byte_budget |
| F07 | S2/S4: a valid-proof rotate pays the device byte budget (a clone crowds out the owner's rotation) | killed | tests/test_review.py::test_failing_envelope_writes_pay_the_device_byte_budget |
| F08 | S2: no per-account envelope byte budget | killed | tests/test_rereview.py::test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets |
| F09 | S2: the account byte budget is not refunded on 403 (a clone exhausts the owner's budget) | killed | tests/test_review.py::test_envelope_writes_have_an_account_byte_budget |
| F10 | S3: the body is read before the session and signer checks | killed | tests/test_limits.py::test_an_unauthenticated_body_is_not_read |
| F11 | S3: 9 MiB bodies without a bounded number of slots | killed | tests/test_rereview.py::test_residual_large_body_slots_are_shared_by_all_accounts |
| F12 | S3: a large-body slot is never given back | killed | tests/test_cas.py::test_twenty_concurrent_puts_same_if_version_exactly_one_wins |
| F13 | S3: no body read timeout (slow bodies hold memory forever) | killed | tests/test_review.py::test_a_stalled_body_times_out |
| F14 | S3: uvicorn without limit_concurrency | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F15 | A9: operations without a body are not capped at 64 KiB | killed | tests/test_limits.py::test_operations_without_a_body_cap_it_at_64_kib[healthz] |
| F16 | S5: IPv6 keyed per /128 | killed | tests/test_review.py::test_ipv6_is_limited_per_64_and_mapped_ipv4_as_ipv4 |
| F17 | S5: IPv4-mapped IPv6 counted apart from the IPv4 address | killed | tests/test_review.py::test_ipv6_is_limited_per_64_and_mapped_ipv4_as_ipv4 |
| F18 | S5: gc does not prune windows (IP-keyed timestamps kept past 1 h) | killed | tests/test_review.py::test_limiter_memory_is_pruned_and_bounded |
| F19 | S5: the window table grows without a cap | killed | tests/test_rereview.py::test_residual_a_full_window_table_refuses_new_device_buckets |
| F20 | S5: the counter table grows without a cap | killed | tests/test_rereview.py::test_a_full_counter_table_answers_429_on_verify |
| F21 | S5: expired counters are never collected | killed | tests/test_review.py::test_limiter_counters_are_bounded_and_expire |
| F22 | S6: Content-Type not checked (cross-site simple requests) | killed | tests/test_review.py::test_json_operations_require_a_json_content_type[text/plain;charset=UTF-8-False] |
| F23 | S6: any charset accepted | killed | tests/test_review.py::test_json_operations_require_a_json_content_type[application/json; charset=latin-1-False |
| F24 | S6: Content-Type matched by prefix (application/jsonx) | killed | tests/test_review.py::test_json_operations_require_a_json_content_type[application/jsonx-False] |
| F25 | S7: a deadlock in a handler is 500 instead of 503 | killed | tests/test_review.py::test_transient_database_errors_map_to_503_and_others_to_500 |
| F26 | S7: the provider's deletion deadlock is not mapped to unavailable | killed | tests/test_review.py::test_account_deletion_racing_a_write_is_retried_once_not_a_500 |
| F27 | S7: the deletion is not retried | killed | tests/test_review.py::test_account_deletion_racing_a_write_is_retried_once_not_a_500 |
| F28 | S8: enrollment create decides one_per_session from a unique violation (ERROR in the PG log) | killed | tests/test_review.py::test_sequential_expected_conflicts_leave_no_error_in_the_postgres_log |
| F29 | S8: recovery decides one_per_session from a unique violation | killed | tests/test_review.py::test_sequential_expected_conflicts_leave_no_error_in_the_postgres_log |
| F30 | S8: concurrent init decided from a unique violation on the vault row | killed | tests/test_review.py::test_concurrent_init_of_one_account_is_decided_again_without_an_error[True] |
| F31 | S8: init's device insert decided from a unique violation | killed | tests/test_review.py::test_init_racing_for_a_device_id_is_device_exists_and_rolls_back |
| F32 | S8: complete's device insert without ON CONFLICT (a taken id is a 500) | killed | tests/test_review.py::test_complete_racing_for_a_device_id_is_enroll_state_and_the_request_survives |
| F33 | S8: fork's device insert decided from a unique violation | killed | tests/test_review.py::test_fork_racing_for_a_device_id_is_device_exists |
| F34 | S8: a concurrent init is answered vault_exists without deciding again (idempotent retry lost) | killed | tests/test_review.py::test_concurrent_init_of_one_account_is_decided_again_without_an_error[True] |
| F35 | S10: the pool acquire has no timeout (requests queue forever) | killed | tests/test_review.py::test_pool_exhaustion_is_503_after_the_acquire_timeout |
| F36 | S11: CREATE on schema public left to PUBLIC | killed | tests/test_account.py::test_otp_is_202_for_any_address_and_creates_an_unconfirmed_user |
| F37 | S11: TEMPORARY on the database left to PUBLIC | killed | tests/test_account.py::test_otp_is_202_for_any_address_and_creates_an_unconfirmed_user |
| F38 | S12: Settings default to dev | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F39 | S12: SIXKEY_ENV unset means dev | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F40 | S12: the app runs the FakeAuthProvider in production | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F41 | S12: dev/test listens on a public address | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F42 | S12: the daily job runs the FakeAuthProvider in production | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F43 | P3: no warning when production has no trusted proxy | killed | tests/test_review.py::test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production |
| F44 | A2: reject-all deletes every open request (no signed-time bound) | killed | tests/test_review.py::test_replayed_reject_all_spares_requests_opened_after_it |
| F45 | A2: reject-all bounded by the server's clock instead of the signed Sixkey-Ts | killed | tests/test_review.py::test_replayed_reject_all_spares_requests_opened_after_it |
| F46 | I2: an audience list containing authenticated is accepted | killed | tests/test_review.py::test_session_claims_are_exact[over0] |
| F47 | I2: a token without role authenticated is accepted | killed | tests/test_review.py::test_session_claims_are_exact[over1] |
| F48 | T1: every device-signed operation also accepts a bare account session | killed | tests/test_review.py::test_a_bare_account_session_never_replaces_a_signature[getSyncStatus] |
| F52 | A21: no per-session buckets for account-session endpoints | killed | tests/test_error_matrix.py::test_every_operation_can_be_rate_limited[getAccount] |
| F53 | A21 (rev 18): an enrolling device counts toward the account ceiling again | killed | tests/test_limits.py::test_enrolling_devices_cannot_fill_the_owners_ceiling_but_their_own_buckets_hold |
| F54 | A21: an enrolling device shares one bucket for every request of the account | killed | tests/test_limits.py::test_enrolling_devices_cannot_fill_the_owners_ceiling_but_their_own_buckets_hold |
| F49 | A18: duplicate keys accepted in request bodies and nested texts | killed | tests/test_contract.py::test_wire_examples_against_the_server_validator[PUT /v1/keys request 3] |
| F50 | A18: NUL accepted in strings | killed | tests/test_contract.py::test_wire_examples_against_the_server_validator[PUT /v1/vault request 1] |
| F51 | A18: lone surrogates accepted in strings | killed | tests/test_contract.py::test_wire_examples_against_the_server_validator[PUT /v1/keys request 4] |
| F55 | RR4: X-Forwarded-For believed by its leftmost (client-written) value | killed | tests/test_limits.py::test_forwarded_for_only_from_a_trusted_proxy |
| F56 | charset: the old leniency (utf8 alias, quoted value) accepted again | killed | tests/test_review.py::test_json_operations_require_a_json_content_type[application/json; charset=utf8-False] |
| F57 | Content-Type: parameters after charset=utf-8 accepted | killed | tests/test_review.py::test_json_operations_require_a_json_content_type[application/json; charset=utf-8; foo=ba |
| F58 | RR1: a body that does not parse (rotate 422/413) pays no bucket | killed | tests/test_rereview.py::test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets |
| F59 | RR1: init pays no byte budget | killed | tests/test_rereview.py::test_init_pays_a_byte_budget_per_session_never_the_accounts |
| F60 | RR1: init charged to the account's budget (the email holder can starve the owner's writes) | killed | tests/test_rereview.py::test_init_pays_a_byte_budget_per_session_never_the_accounts |
| F61 | RR3: a full counter table is answered otp_invalid instead of 429 | killed | tests/test_rereview.py::test_a_full_counter_table_answers_429_on_verify |
| F62 | 0002 post-condition only warns (a no-op revoke goes unnoticed on Supabase) | killed | tests/test_migrations.py::test_0002_fails_instead_of_silently_doing_nothing |
| F63 | A21 (rev 18): no per-rid limit for enrolling devices | killed | tests/test_error_matrix.py::test_every_operation_can_be_rate_limited[revealEnrollRequest] |

## 7. Not done

- **SupabaseAuthProvider and everything else M8 needs**: the final checklist is §10. The interface is `auth_provider.AuthProvider`; each method's docstring names its Supabase call.
- **More than one API instance** would need a shared store for the rate limits (§5.1 says Redis).
- **M7**: KMS application-layer encryption of `bundle` and `write_key` (S7).
- The TS contract tests against this server (§8.5; A30, now §9 M5).
- Left in the local cluster after development (`api/server/.pg/`, git-ignored): the `sixkey_dev` database used by `make run`, and `.pg/otp-inbox.jsonl` with fake OTP codes. `make pg-reset` removes all of it.

## 8. What a reviewer should attack

1. The order inside PUT /v1/keys and rotate (A5): the idempotent 200 before any proof; the 409 before the proofs.
2. The lock change and order (A1): FOR NO KEY UPDATE; device rows (by id) → vault row → enrollment rows (by id) in every transaction; rotate locking all device rows before its CAS; `complete` and `revoke` taking the vault row before request rows. Look for any path that takes a later level first and then an earlier one (the account-deletion cascade is the one known exception, A1).
3. The pipeline's limit accounting: refund on 401/403, the valid-proof exemption decided before the handler, the account ceiling exemptions (revoke, rotate), enrolling devices counted per request id and never toward the account ceiling (rev 18).
4. Enrollment guards: every advancing statement carries `expires_at > now`; the classification query after a miss; `complete` deleting the request before creating the device (and rolling back on 409).
5. The raw target: ASGI `raw_path` + `query_string` behind a proxy that rewrites paths or sets `root_path`; an empty query (`/x?`) is signed by clients as `/x` (WHATWG `URL.search` is empty), matching the server.
6. Strict JSON vs the clients' `JSON.parse` (duplicate keys, `-0`, big integers, NUL, escapes in the envelope text) — the stored text is byte-for-byte what clients parse.
7. The server-side schema validator (`schema.py`): ECMA `$` handling, the fast base64 path being the same language as the contract's regex.
8. Logs: exception class names are logged on 5xx; uvicorn's own error logger; anything else that could carry request data.
9. FakeAuthProvider fidelity to Supabase (claims, `session_id`, logout semantics, user creation on send).
10. Retention with the byte cap (A24) and the daily job racing PUTs (it locks the vault row).
11. (second round) The pipeline's new order (§3.1): everything that needs no body before `read_body`; check that no path reads a body for an unknown signer, and that `verify_signer` runs for every signer looked up before the body.
12. (second round) The byte budgets and the valid-proof bucket (§9.2): who pays, what is refunded, and whether a copy without the password or the VK can exhaust anything the owner needs (revocation, rotation, another device's writes).

## 9. Second round: the review `docs/audit/internal-reviews/M4-REVIEW.md`

The review's verdict was MERGE AFTER FIXES (medium: S1, S2, S3, T1; low: S4–S14, T2, T3; informational I1–I4; deployment P1–P6). Every finding was first reproduced with the reviewer's probes (`review/test_review_probes.py`, 13 probes, all reproduced on the first-round code); the probes then became regression tests in `tests/test_review.py`, asserting what the server must do instead of what it did. The reviewer's 32 mutants are now part of `tests/mutation/mutants.py` (R01–R32), next to one or more new mutants per fix (F01–F54).

### 9.1 Findings: fixed and declined

| ID | Status | What changed | Tests (`tests/test_review.py` unless named) | Mutants |
|---|---|---|---|---|
| S1 | fixed | `routes/auth.py: verify` reserves the attempt (`incr` on the per-email counter) **before** awaiting the provider; a success is not refunded; a new code resets the counter (A22). | `test_otp_attempts_are_reserved_before_the_provider_is_awaited`: 40 concurrent wrong guesses with a 50 ms provider, exactly 5 reach it, and the right code is then refused without asking the provider | F01, F02, M28 |
| S2 | fixed | A per-account bucket for requests with a **valid** proof (`proof_valid_account`, 60/60 s; revoke and rotate included; invalid proofs never reach it, they stop in their own bucket). Envelope byte budgets: per device (256 MiB/h, every envelope request without a valid proof) and per account (1 GiB/h, every envelope write). The contract has no numbers for either, so they are server-chosen (§9.2). | `test_valid_proof_requests_are_bounded_per_account`, `test_envelope_writes_have_an_account_byte_budget` | F04, F07, F08, F09 |
| S3 | fixed | `run()` checks everything that needs no body first (Content-Length, Content-Type, the account session, the signer headers' shape, the device or enrollment row), so an unauthenticated client never makes the server read a body. The body is read within `body_timeout_s` (60 s, else 503). The three 9 MiB operations wait at most `large_body_wait_s` (10 s) for one of `large_body_slots` (8), else 503. uvicorn runs with `limit_concurrency` 256 (`SIXKEY_LIMIT_CONCURRENCY`) and `timeout_keep_alive` 5 s. **Not moved before the body:** the ±300 s window, because P6 orders verify → revoked → window, and moving it would change which error a request with several faults gets. **Residual:** whoever knows a device id (it is not secret: every device of the account sees it in `GET /v1/devices`) can still make the server read up to 9 MiB that then fails `bad_signature`; that is bounded by the 8 slots (72 MiB), the body timeout and, at M8, the proxy's body size and timeouts. | `test_large_body_requests_wait_for_a_bounded_number_of_slots`, `test_a_stalled_body_times_out`, `test_limits.py::test_an_unauthenticated_body_is_not_read`, `test_uvicorn.py` (an unsigned chunked body is 401 before it is read), the uvicorn arguments in the S12 test | F10–F14, R27 |
| S4 | fixed differently | `write_denied` and every other failing envelope write pays the **device byte budget**, which is never refunded. A valid-proof request (the owner's rotate) is exempt from it, so a copy without the password cannot crowd out rotation. **Declined:** the suggested non-refundable per-device bucket for `bad_signature`, because anyone who merely knows a device id could fill it and lock the real device out of its own writes; a bad signature costs the server one verification and, for 9 MiB bodies, one slot (S3). | `test_failing_envelope_writes_pay_the_device_byte_budget` | F05, F06, F07 |
| S5 | fixed | IP keys: IPv6 per /64, IPv4-mapped IPv6 as the IPv4 address (`pipeline.ip_key`). The limiter stores each key's window and a garbage-collection pass (at least every 60 s or 256 operations) prunes every key to its window, so IP-keyed timestamps live at most their window (1 h, `IP_COUNTER_TTL_S`); plain counters expire after 1 h; both tables are capped at `limiter_max_keys` (200 000): past the cap a new key is refused (429) instead of growing memory. | `test_ipv6_is_limited_per_64_and_mapped_ipv4_as_ipv4`, `test_limiter_memory_is_pruned_and_bounded`, `test_limiter_counters_are_bounded_and_expire` | F16–F21 |
| S6 | fixed | Every operation with a JSON body requires `Content-Type: application/json` (case-insensitive; `charset=utf-8` allowed, any other charset refused; since §11 exactly the contract's rule, no `utf8` alias, quoted value or other parameter), checked before the body: 422 `invalid_request`. A cross-site page can no longer trigger an OTP email or spend verify attempts with a "simple" request. | `test_json_operations_require_a_json_content_type` (9 types), `test_content_type_is_checked_on_signed_operations_too` | F22–F24 |
| S7 | fixed | Deadlock and serialization failures are transient: `db.map_exception` answers 503 + `Retry-After: 5`. The FakeAuthProvider's `delete_user` maps them to `ProviderUnavailable`; `DELETE /v1/account` retries the deletion once after 50 ms, then answers 503. | `test_account_deletion_racing_a_write_is_retried_once_not_a_500` (deterministic: the test waits until the cascade is blocked on the device row before releasing the PUT, so the cascade waited first and Postgres aborts it; the retry answers 204 and every row is gone; 20/20 under a concurrent second suite run), `test_account_deletion_retries_once_then_answers_503`, `test_transient_database_errors_map_to_503_and_others_to_500` | F25–F27 |
| S8 | fixed | Expected unique conflicts are decided with `INSERT … ON CONFLICT DO NOTHING RETURNING` instead of an ERROR: enrollment create and recovery (`one_per_session`), init's vault row (a concurrent init: decide again, so a double submit is still 201), init's device row (`device_exists`), complete's device row (`enroll_state`, the request survives), fork's device row (`device_exists`). The `UniqueViolationError` handlers stay as fallbacks. New pause points `init.checked`, `complete.before_insert`, `fork.before_insert` make the races deterministic. **Residual:** a foreign-key violation (init or enrollment create with the token of an auth user deleted within the token's 15 minutes) is still an ERROR in the Postgres log (answered `session_invalid`); with terse logging it carries no DETAIL. | `test_concurrent_init_of_one_account_is_decided_again_without_an_error[same/different body]`, `test_init_racing_for_a_device_id_is_device_exists_and_rolls_back`, `test_complete_racing_for_a_device_id_is_enroll_state_and_the_request_survives`, `test_fork_racing_for_a_device_id_is_device_exists`, `test_sequential_expected_conflicts_leave_no_error_in_the_postgres_log` (each reads the Postgres log written during the test), `test_zz_logs.py` (no "duplicate key value" in the whole run) | F28–F34 |
| S9 | decided by the owner (delegated): no cache | The reject-all bound; six residuals documented (§9.3). | §9.3 | F44, F45 |
| S10 | fixed | `db.Db` wraps the pool; every `acquire` waits at most `db_acquire_timeout_s` (5 s), then 503. | `test_pool_exhaustion_is_503_after_the_acquire_timeout` | F35 |
| S11 | fixed | `migrations/0002_least_privilege.sql`: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, `REVOKE TEMPORARY, CREATE ON DATABASE … FROM PUBLIC` (idempotent). Privileges are additive, so revoking from `sixkey_api` alone would not help. | `test_db_roles.py::test_api_role_cannot_create_anything_anywhere`, `test_migrations.py` | F36, F37 |
| S12 | fixed | `Settings.env` defaults to `production`; `Settings.from_env` exits unless `SIXKEY_ENV` is exactly dev, test or production; the app's lifespan and the daily job refuse `production` (no SupabaseAuthProvider yet); `python -m sixkey_server` refuses a non-loopback bind for dev/test. P3: production without `SIXKEY_TRUSTED_PROXIES` logs the event `warning_no_trusted_proxy` at startup. | `test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production` | F38–F43 |
| S13 | fixed | `FastAPI(..., redirect_slashes=False)`: `/v1/vault/` is the contract's 404 `not_found`, no Location built from Host. | `test_trailing_slash_is_404_not_a_host_built_redirect`, `test_uvicorn.py` | F03 |
| S14 | fixed upstream; second oracle here | `contract/py` was not edited here. Recommended change (§9.5), since applied by the contract owner (`parse_strict_json`). `tests/sk.py: strict_json` stays as an independently written second oracle and checks every 2xx envelope and bundle text the server returns. | `test_both_text_oracles_reject_non_strict_json` (12 texts), `test_both_text_oracles_accept_strict_json` (6) | (tests only) |
| T1 | fixed | — | `test_a_bare_account_session_never_replaces_a_signature` (every device- or enroll-signed operation), `test_a_device_signature_never_replaces_the_account_session` (every session operation) | R01, F48 |
| T2 | fixed | — | `test_clear_history_racing_a_revocation`, `test_clear_history_racing_a_put_keeps_the_head`, `test_put_keys_racing_a_revocation`, `test_rotate_racing_a_put_keys_loses_the_kver_cas` (pause points `delete_versions.before_tx`, `delete_versions.locked`) | R10, R11, R24 |
| T3 | fixed | `test_zz_logs.py` now checks every value of a request line (route template, method, status code set, exception class name pattern, rid format). | `test_rotate_compares_by_with_the_signer`, `test_idempotency_is_byte_for_byte_not_by_kver[mac/at]`, `test_the_byte_cap_never_drops_the_head` | R07, R09, R16, R26 |
| I1 | no change | Rotate's `device_names` completeness: design (A6, accepted). | — | — |
| I2 | fixed | The session's `aud` must be the string `authenticated` (no list) and `role` must be `authenticated`. | `test_session_claims_are_exact` | F46, F47 |
| I3 | declined | A keyless check of `commit` at reveal is a protocol rule P1 gives to the approver A; adding it to the server is a design change. For the design owner: it costs one hash and would refuse a buggy new device early. | — | — |
| I4 | no change | FastAPI stays (D1) at 0.141.1; pip-audit clean (§9.6). | — | — |
| P1–P6 | M8 | P3's startup warning and P5's body timeout are in the app now; the rest is in §10. | — | — |

Contract resync (revision 15), adapted in the same pass: the 10 new (bodyless operation, 413, `too_large`) pairs are observed (`test_limits.py::test_operations_without_a_body_cap_it_at_64_kib`); `MinuteMs` matches A13; `test_contract.py::test_rate_limit_defaults_match_the_contract` passes with `session_writes`/`session_reads`, and the new limits tests cover them and the `enroll:{rid}` keys (F52–F54); the server validator agrees with the four new strict-text counterexamples (duplicate key in a bundle text, escaped NUL in an envelope text, escaped lone surrogate in a bundle text, `"rev":42.0` in an envelope text; mutants F49–F51); `PUT /v1/keys` has no write-proof step and checks shape/kver → identical text 200 → CAS 409 → pw_auth 403 (counted) → vaultId/vkId/by/P4 422, as the contract now writes it.

### 9.2 Numbers the server chose (not in the contract; all in `config.py`)

| Setting | Value | Why |
|---|---|---|
| `limits.proof_valid_account` | 60 requests / 60 s per account | S2: twice the per-device write rate; an owner never revokes or rotates that often, a flood is stopped |
| `limits.device_envelope_bytes` | 256 MiB / hour per device, never refunded (counts request-body bytes; init has no device and does not pay it, §11.1) |
| `limits.session_envelope_bytes` | 1 GiB / hour per account session, for init only (§11.1) | S4: 32 full 8 MiB envelopes an hour; failing writes pay too; valid-proof requests are exempt |
| `limits.account_envelope_bytes` | 1 GiB / hour per account, refunded on 401/403 (request-body bytes; PUT and rotate, not init, §11.1) | S2: 128 full envelopes an hour across all devices; a copy's refused writes cannot spend it |
| `large_body_slots` / `large_body_wait_s` | 8 / 10 s | S3: at most 72 MiB of 9 MiB bodies in memory |
| `body_timeout_s` | 60 s | S3/P5: a 9 MiB body at 150 KB/s still fits |
| `limiter_max_keys` | 200 000 keys per table | S5: tens of MB at most |
| `SIXKEY_LIMIT_CONCURRENCY` (uvicorn `limit_concurrency`) / `timeout_keep_alive` | 256 / 5 s | S3 |
| `db_acquire_timeout_s` | 5 s (existed, now used) | S10 |
| Account deletion retry | once, after 50 ms | S7 |

The contract's own numbers (`session_writes` 30/60 s, `session_reads` 60/60 s, the OTP, recovery and device numbers) are the defaults and are checked against `x-sixkey-rate-limits`. Proposed for §5.5: list the four rows above the line.

### 9.3 Replay residuals (for the design owner)

Decided (owner-delegated): **no nonce cache.** A cache would turn Chromium's automatic resend of an already-processed request into a 401 and would only work in one process. Every residual below needs a captured, TLS-protected signed request replayed inside its ±300 s window, and none exposes plaintext (§5.2). Each one has a test that pins the behaviour, so a change is noticed.

| # | Replayed request | Effect inside the window | Test |
|---|---|---|---|
| 1 | `POST /v1/enroll/reject-all` | **Mitigated:** it deletes only requests created at or before the minute of its signed `Sixkey-Ts` (`created_at <= minute_floor(ts)`), so requests opened after the original survive. What remains: a request opened later in the *same* minute as the original signature (created_at has minute precision, C14) is still rejected by a replay. | `test_replayed_reject_all_spares_requests_opened_after_it` |
| 2 | `DELETE /v1/vault/versions` | Erases the history written since the original (up to 5 minutes of versions); the head is never deleted. | `test_residual_replayed_clear_history_erases_history_written_since` |
| 3 | `POST /v1/enroll/requests` after the request was rejected | A phantom pending request with the old commit appears again in the approvers' list. It cannot advance without the new device's key (reveal and complete are signed by it). | `test_residual_replayed_enrollment_create_after_a_reject` |
| 4 | `POST /v1/enroll/recovery` after `reject-all` | The approved recovery request is created again for the same new-device key, and the response carries the current envelope and bundle (ciphertext, as in the original response). Only the holder of that key can complete. | `test_residual_replayed_recovery_enrollment_after_reject_all` |
| 5 | Any signed GET | Returns the state at replay time (ciphertext for vault, keys and versions; metadata for status, devices and enrollments) for up to 5 minutes after signing. | `test_residual_signed_gets_replay_inside_the_window_only` (299 s: 200; 301 s: `clock_skew`) |
| 6 | `PATCH /v1/devices/{id}` (rename, the case §5.2 always named) | Restores the older name ciphertext over a later rename. | `test_residual_replayed_rename_restores_the_older_name` |

Revision 15 records the same six in §1.2 A6, §5.2, §7 and §10 #93.

### 9.4 The reviewer's probes as regression tests

| Probe (review/test_review_probes.py) | Became |
|---|---|
| OTP per-code limit check-then-act | `test_otp_attempts_are_reserved_before_the_provider_is_awaited` |
| valid-proof revoke and rotate unlimited | `test_valid_proof_requests_are_bounded_per_account` |
| unauthenticated 9 MiB body read before auth | `test_limits.py::test_an_unauthenticated_body_is_not_read`, `test_uvicorn.py` |
| write_denied never limited; bad_signature never limited | `test_failing_envelope_writes_pay_the_device_byte_budget` (bad_signature: declined, §9.1 S4) |
| IP buckets per /128 and living past 1 h | `test_ipv6_is_limited_per_64_and_mapped_ipv4_as_ipv4`, `test_limiter_memory_is_pruned_and_bounded` |
| cross-site simple request triggers an OTP | `test_json_operations_require_a_json_content_type` |
| deletion racing a write → 500 | `test_account_deletion_racing_a_write_is_retried_once_not_a_500` |
| unique violations in the Postgres log | the five S8 tests and `test_zz_logs.py` |
| replays (reject-all, clear history, enrollment create, recovery) | §9.3 tests |
| pool exhaustion queues forever | `test_pool_exhaustion_is_503_after_the_acquire_timeout` |
| `SIXKEY_ENV` defaults to dev | the S12 test |
| trailing-slash redirect | `test_trailing_slash_is_404_not_a_host_built_redirect` |
| the oracle accepts non-strict texts | `test_both_text_oracles_*` |

### 9.5 S14: what `contract/py` should change (recommended; since applied upstream)

In `validate()`, for a string schema with `contentMediaType: application/json` and a `contentSchema`, parse the text strictly before validating it: `json.loads(text, parse_float=reject, parse_constant=reject, parse_int=safe_int, object_pairs_hook=no_duplicates)`, where `safe_int` rejects |n| > 2^53 − 1 (the vector-tested `integer_tokens_only` rule), `no_duplicates` compares keys after unescaping, and a walk over the result rejects NUL and lone surrogates in every key and string; a failure is a validation error, not an exception. The contract owner has since added exactly this (`parse_strict_json`), and both oracles agree on every case in §9.1.

### 9.6 Dependencies

All pins unchanged and installed exactly (`pip freeze` = the two requirement files). `pip-audit -r requirements-dev.txt` (in a separate venv): **no known vulnerabilities**. Only `fastapi` is behind its latest release (0.141.1 vs 0.143.3), held on purpose (0.142+ pulls in `opentelemetry-api`).

## 10. Final M8 checklist

Merged from the review's §8 (12 items, now in SYNC-DESIGN §9 after the M8 row) and this milestone's own M8 list. Verify each item on the real Supabase project and host, not locally.

1. **Signing keys.** Asymmetric ES256 signing keys only; the legacy HS256 secret is never accepted; `iss` matches exactly; JWT lifetime 900 s; anonymous sign-ins off. JWKS cached, refreshed on an unknown `kid` at most once per N seconds (P2).
2. **Tokens verified locally only** (JWKS); never call `/auth/v1/user`: the session is logged out right after verify by design, so `/user` would refuse it.
3. **OTP.** Template with `{{ .Token }}` only, length 6; a new code voids the old one. Map Supabase's 60 s resend limit and every 4xx/429 to responses that do not reveal whether the email exists; measure the timing of new vs existing emails and pad if needed (P1). `create_user: true`. Do not forward the client IP to Supabase, and raise Supabase's per-IP limits accordingly (S1 is fixed in the API).
4. **Refresh token dead after logout.** `logout?scope=local` right after verify; prove with the real project that the refresh token no longer works. A failed logout is 503 (A23).
5. **Deleting users.** Admin API hard delete (`should_soft_delete=false`); the cascade under the GoTrue role empties every sixkey row through RLS. Deletion racing a write → 503 + retry (§5.7, S7): map the provider's errors to `ProviderUnavailable` only when nothing was deleted. `purge_unconfirmed` implemented and scheduled daily with retention; output counts only.
6. **Migrations.** Run `0001_sixkey.sql` as `postgres`; `GRANT REFERENCES ON auth.users TO sixkey_owner` must succeed (`auth.users` belongs to `supabase_auth_admin`), else use the fallback (A26); the `sixkey` schema is not in the API-exposed schemas. Before `0002_least_privilege.sql`, check that no Supabase role relies on PUBLIC's CREATE on `public` or TEMP on the database (it revokes them from PUBLIC). Run 0002 as the owner of schema `public` and of the database: a non-owner's `REVOKE … FROM PUBLIC` only warns, and 0002's post-condition then raises and rolls the file back (§11.1), which is the signal to switch roles, not to edit the file.
7. **Audit privileges as `sixkey_api`.** Schema and table privileges in `auth`, `storage`, `vault`, `extensions`, `graphql`, `realtime`, `public`, `sixkey_meta`; CREATE and TEMP on the database (S11); `anon`, `authenticated`, `service_role` have no USAGE on `sixkey`. Run `test_db_roles.py` and `test_migrations.py` against the project.
8. **Connections.** `sixkey_api`'s password set outside the migration; connect through the Supavisor transaction pooler (`sixkey_api.<ref>`, port 6543) with `statement_cache_size=0`; prove through the pooler that sessions are UTC; size `SIXKEY_DB_POOL_MAX` against the pooler and keep `db_acquire_timeout_s` (S10).
9. **Postgres logs.** `log_error_verbosity = terse` settable and set (S8 removed the expected unique-violation ERRORs; the FK residual of §9.1 S8 remains); `log_parameter_max_length_on_error = 0`, `log_statement = none`, no pgaudit for `sixkey_api`; trigger `one_per_session` on purpose and check the log explorer.
10. **Hosting.** **Never expose uvicorn directly** (RR5): idle TCP sockets that send nothing hold one of `limit_concurrency`'s slots until they close, so 256 of them deny the service to everyone, unauthenticated. The reverse proxy MUST enforce a request/header read-idle timeout, a per-IP concurrent-connection cap and a body read timeout below 60 s, and `SIXKEY_LIMIT_CONCURRENCY` must be sized above the proxy's own connection cap. The 8 large-body slots are one pool for all accounts (RR2): the per-IP connection cap is what keeps one source from holding them. Access logs off or without IPs; exactly one instance (the limits are in memory; otherwise Redis). `SIXKEY_TRUSTED_PROXIES` = that one proxy, which appends the client address as the rightmost `X-Forwarded-For` value (the app warns at startup if it is unset, P3); verify that it really appends (the server test `test_forwarded_for_only_from_a_trusted_proxy` checks the rightmost-value rule, RR4); IPv6 counts per /64. At the proxy: body size limit (9 MiB), body and idle timeouts (S3, P5); no URL normalization, no header merging, DELETE bodies forwarded (P4). Re-run the dropped-DELETE-body test (N25) and the percent-encoded target test through the real proxy; TLS. Tune `SIXKEY_LIMIT_CONCURRENCY` and `large_body_slots` to the instance's memory.
11. **Configuration.** `SIXKEY_ENV=production` (S12); `SIXKEY_API_ORIGIN` = the exact public host; `SIXKEY_CORS_ORIGINS` = the store extension ID (plus the dev ID); `min_client_version`; the daily job scheduled (cron or pg_cron).
12. **Disclosure.** The privacy policy states the backup / PITR window (§5.7); Supabase's auth audit log keeps server IPs and emails (PRIVACY).
13. **Capacity (P6).** Storage alarms; decide on a global sign-up ceiling (each account can hold about 72 MiB, accounts are cheap). The limiter's tables are shared by all key families (RR3b): with more than one instance, or if IP keys crowd out device keys in practice, move to Redis with a cap per family.
15. **OTP lockout of a chosen email (RR6, accepted for Phase 1).** Without any authentication, wrong verifies from any IP spend an email's 5 attempts on its current code, and many IPs can fill its 50 sends a day, locking that email out of sign-in, recovery-code enrollment, new-device enrollment, init and step-up deletion for up to a day (pinned by two tests, §11.2). M8 chooses the mitigation: Supabase-side protection (CAPTCHA / Turnstile; a contract change, since the API proxies `/otp`), or a verify-failure policy a third party cannot exhaust.
14. **SMTP** and its DNS records; the `api.sixkey.app` domain (and a dev domain).

Owner inputs: the Supabase project (URL, publishable/secret key, JWKS URL) and its log settings; DNS; the SMTP provider; the hosting choice; the store extension ID; legal review of the privacy policy.

## 11. Third round: the re-review `docs/audit/internal-reviews/M4-REREVIEW.md`

Verdict MERGE (critical 0, high 0; medium RR2, RR5, RR6; low RR1, RR3, RR4; none blocks merge or M5). The contract is now revision 16 (the three server-chosen limits with `"source": "m4"` and `"unit": "bytes"`, `x-sixkey-request-rules.json_content_type`, the 503 sources); `make check` (469), `make contract` (40/40) and the consistency checker (0 mismatches) pass against it.

### 11.1 Fixed

| ID | What changed | Tests | Mutants |
|---|---|---|---|
| RR1 | **A body that does not parse pays every bucket.** On operations whose proof is evaluated after parsing (rotate, revoke, the other pw_auth operations, and the registration-signed ones), a parse failure (422, or 413 for an oversized envelope) now runs `charge()` before the error: such a body carries no valid proof, so it pays the device write bucket, the account ceiling, the device byte budget and the account byte budget. `PUT /v1/vault` already charged before parsing. **init pays a byte budget per account session** (new setting `session_envelope_bytes`, 1 GiB/h, the account budget's number) besides its `session_writes` bucket, parsed or not. It pays **no device byte budget**: there is no device row yet, and the device id is whatever the client writes into the body, a fresh one per request if it likes. It also does **not** pay the account's budget, deliberately: a session needs only the email, and charging init to the account would let whoever controls the email (or gets one OTP through) use up, with 409/422 inits, the budget the account's devices write against, an email-only attacker affecting the vault, which D2 rules out. **What a byte budget counts: the whole request body** (`len(body)`), not only the envelope text. That is what the revision-16 rule already says ("a limit with unit bytes counts request bytes"), it is what can be counted before the envelope is known to parse (a malformed body has no envelope text to measure), and it differs from the envelope's size by at most the other members (the bundle and the proofs, well under 1 MiB). | `test_rereview.py::test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets` (probe P1; also a body that is not JSON at all), `::test_init_pays_a_byte_budget_per_session_never_the_accounts` (an init flood leaves the account's budget untouched) | F58, F59, F60 |
| RR3 | `Limiter.incr` returns None when its table is full and the key is new; `verify` then answers **429 `rate_limited` + `Retry-After: 60`** (as `hit()` does), not `otp_invalid`, and does not ask the provider. | `::test_a_full_counter_table_answers_429_on_verify` (probe P3), `test_review.py::test_limiter_counters_are_bounded_and_expire` | F20, F61 |
| RR4 | Test only (the code was right): from the trusted proxy, `X-Forwarded-For: <forged>, <client>` is counted by the rightmost value, three different forged left values share one bucket, and two separate XFF header lines are not believed (the peer counts). | `test_limits.py::test_forwarded_for_only_from_a_trusted_proxy` | F55 (the reviewer's surviving X18) |
| charset | **Exactly §5.4 / `json_content_type` now.** Round 2 also accepted `charset=utf8`, a quoted `charset="utf-8"` and any further parameter; now the media type is `application/json` (case-insensitive, optional whitespace around the `;`) and the only parameter allowed is `charset=utf-8` (case-insensitive). `utf8`, a quoted value, `charset = utf-8`, a trailing `;` and every other parameter are 422. No contract change is needed; the contract's wording is what the server does. | `test_review.py::test_json_operations_require_a_json_content_type` (17 values) | F23, F24, F56, F57 |
| 0002 | A post-condition at the end of `0002_least_privilege.sql` raises if `sixkey_api` still has CREATE on schema `public` or TEMPORARY/CREATE on the database. A `REVOKE … FROM PUBLIC` run by a role that owns neither only WARNs and succeeds (confirmed by the re-review), so on Supabase 0002 could otherwise report success and change nothing; raising rolls the file back (one transaction per file) and it is not recorded. The file changed, and the runner refuses a file whose hash differs from the one recorded: only local databases can have the old 0002 recorded (`make pg-reset` once; the local `sixkey_dev` here had never applied it and took the new one). | `test_migrations.py::test_0002_fails_instead_of_silently_doing_nothing` (as a non-owner role after re-granting PUBLIC's CREATE: raises; as the owner: passes and removes it; everything rolled back) | F62 |
| §6 claim | **"No mutant hung" was wrong for single-test runs.** With F12 (a slot never returned) the slot test waited forever on its pause point, because the setup's own init had taken the only slot. Every wait on a pause point now has a 10 s timeout, and `conftest.py` has a per-test watchdog (`SIXKEY_TEST_TIMEOUT_S`, 300 s, 120 s in the mutation runner): a timer thread lifts pytest's output capture, prints the hung test's id and every thread's stack (`faulthandler`) to the real stderr and exits non-zero (checked with a test that sleeps past a 2 s limit); the runner reports such a run as killed by the watchdog, and a run that still exceeded its own 1800 s limit as "killed (hang)", instead of stalling. F12 on the slot test alone now fails in about 10 s. | — | F12 |

### 11.2 The nine probes as regression tests (`tests/test_rereview.py`)

| Probe | Test | Asserts |
|---|---|---|
| P1 rotate 422 bypasses the byte budget | `test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets` | fixed (RR1) |
| P2 slots global across accounts | `test_residual_large_body_slots_are_shared_by_all_accounts` | residual (RR2) |
| P2b slot taken before the signature is checked | `test_residual_a_known_device_id_takes_a_slot_before_its_signature_is_checked` | residual (RR2; with a free slot the same request is `bad_signature`) |
| P3 counter table full → otp_invalid | `test_a_full_counter_table_answers_429_on_verify` | fixed (RR3) |
| P3b full window table refuses a fresh device bucket | `test_residual_a_full_window_table_refuses_new_device_buckets` | residual (RR3b), over HTTP: 429 + Retry-After 60 |
| P7 reject-all signed by a fast clock | `test_reject_all_signed_by_a_fast_clock_reaches_requests_opened_after_it` | residual; the reason §4.14 requires signing with the corrected clock |
| P8 a resend resets the attempts | `test_a_new_code_brings_five_more_attempts_at_the_price_of_a_resend` | by design (A22): exactly 5 + 5 reach the provider, made deterministic (the resend happens once five guesses are inside the provider) |
| P9 any IP burns an email's code | `test_residual_any_ip_can_spend_an_emails_five_verify_attempts` | residual (RR6); a new code works again |
| P9b many IPs fill an email's daily sends | `test_residual_many_ips_can_fill_an_emails_daily_send_bucket` | residual (RR6); the window frees after a day |

### 11.3 For the design owner and M8

- **RR5 (idle sockets, medium, launch gate):** never expose uvicorn directly; the proxy enforces a request/header read-idle timeout, a per-IP connection cap and a body read timeout below 60 s; `limit_concurrency` above the proxy's cap. No in-app fix is enough: uvicorn's `timeout_keep_alive` only covers the time between requests. M8 checklist item 10.
- **RR2 (global large-body slots, medium):** the documented S3 residual. The slot is taken after the signer row is found and before the signature is verified (the signature covers the body, so the body has to be read first); one source can hold all 8 slots for up to 60 s each, cycling. The control is the proxy's per-IP connection cap (item 10). Per-source slot fairness in the app is possible later; not done.
- **RR6 (OTP lockout of a chosen email, medium): decided, accepted and documented for Phase 1;** M8 chooses the mitigation (item 15).
- **RR3b:** shared key cap across key families; M8 item 13.
- **The same category elsewhere:** keeping init off the account's byte budget (§11.1) stops an email-only holder from draining the devices' write budget, but A21 then still counted enrolling devices toward the account's ceiling (about 20 sessions polling at their limit fill `account_reads`). **Decided in revision 18 and implemented (§12):** enrolling devices no longer count toward it.
- **0002 on Supabase:** run it as the owner; the post-condition makes a no-op fail loudly (item 6).

**Proposed wording changes (for the design owner / contract owner):**
- §5.5 "envelope 字节": say that the budgets count the request body's bytes (the whole body, also when it does not parse), matching the contract rule "a limit with unit bytes counts request bytes".
- Contract: drop `POST /v1/vault/init` from both `device_envelope_bytes.applies_to` (no device yet) and `account_envelope_bytes.applies_to` (an email-only holder must not drain the account's write budget), and add `session_envelope_bytes` (key: account session, 1073741824 bytes / 3600 s, unit bytes, source m4, applies to `POST /v1/vault/init`, parsed or not; 401/403 refunded). §5.5 gets the same row.
- Contract rules (optional): "a request whose body does not parse carries no valid proof and pays every bucket that applies to it".
- `json_content_type`: no change (the server now does exactly what it says).

### 11.4 Mutation check, third round

`tests/mutation/mutants.py` now holds 139 mutants: the 131 of the second round (M28, F01, F23 and F24 re-targeted at the changed code) and F55–F62 for this round. **139/139 killed** (about 51 minutes); table in §6.

## 12. Revision 18 (§0.0r): A21, enrolling devices off the account ceiling

Revision 18 accepted the third round's decisions (init pays only `session_envelope_bytes`; byte budgets count the whole request body; a full OTP counter table is 429; the exact `Content-Type` rule) and decided A21: an enrolling device (`enroll:{rid}`) does **not** count toward `account_reads` or `account_writes`. The reason is the same as for init: whoever controls only the email must not be able to affect the owner's devices, and about 20 enrolling sessions polling at their limit would otherwise fill `account_reads` and make the owner's status polls 429.

- **Server:** `Ctx.charge()` charges the account ceiling for enrolled devices only (`pipeline.py`); an enrolling device keeps its own `enroll:{rid}` buckets (`device_reads`, `device_writes`). It never had a byte budget or the valid-proof bucket (enrollment endpoints carry no envelope and no proof).
- **What still bounds an email holder:** each enrolling device's per-rid buckets, one pending request per account session (`one_per_session`), and the OTP send limits that every session costs (3 per email and IP per 10 minutes, 10 per email and IP per day, 50 per email per day, 20 per IP per hour). The cost is server load only.
- **Tests** (`tests/test_limits.py`): `test_enrolling_devices_cannot_fill_the_owners_ceiling_but_their_own_buckets_hold` (three enrolling sessions poll 60 times each, 180 reads against an account ceiling of 100: each rid is stopped at its own 60, the owner's status poll is 200 and the account counter holds only the owner's read; one enrolling device's 30 identical reveals against `account_writes` = 4 leave the owner's next write unlimited, the 31st reveal is 429), and `test_enrolling_sessions_are_bounded_by_the_otp_limits_and_one_request_each`.
- **Mutants:** F53 now restores the account charge for enrolling devices; F63 drops the per-rid limit; F54 keys the per-rid bucket by account. All three killed (re-run on this code with `--only`; the full 139-mutant run of §6 was on the code just before this change, and this change touches only the account-ceiling line).
- **Contract:** resynced concurrently by the contract owner (the enrolling-device rule, `session_envelope_bytes`, the revision-18 byte-budget wording and the exact `json_content_type` text, not edited here); `make contract` 42/42, the consistency checker 0 mismatches, and `test_rate_limit_defaults_match_the_contract` passes against it.
