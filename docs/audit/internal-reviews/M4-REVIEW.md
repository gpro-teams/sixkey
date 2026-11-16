# M4 security review: the sync API

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading, repository paths updated to the current layout and absolute local paths
> shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were
> **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the test
> suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

Scope: `api/server/` (FastAPI + Postgres + FakeAuthProvider, uncommitted) against `docs/SYNC-DESIGN.md` rev. 14
(§3, §5, §8.4/§8.5, §10, §13), `api/openapi.yaml`, `contract/vectors/sync-v1.json`, `contract/py/sixkey_contract.py`,
`contract/M0-NOTES.md`, `docs/design/notes/M1-NOTES.md`, `docs/security/local-vault.md`, `docs/research/security-incidents-report.md` §E.
`docs/design/notes/M4-NOTES.md` was read after the code review, to compare.

Review only: no file in the repository was changed except this one. All experiments ran in a scratch copy
(`…/scratchpad/m4-review/`, its own venv, its own Postgres 14 cluster on 127.0.0.1:55437; the implementer's `.pg/`
was never touched).

## 0. Summary

The server is careful and mostly right. I found no authentication bypass, no tenant-isolation hole, no CAS or
key-operation bug, and no enrollment state-machine bypass. Every endpoint's credential matches the contract's
`x-sixkey-auth`. Every SQL statement filters by tenant. The lock order holds everywhere except the known
account-deletion cascade. Logs carry only the allowed fields.

What I did find, all confirmed by running it:

- **The OTP per-code limit is check-then-act.** With a provider that awaits the network, which Supabase will,
  40 of 40 concurrent guesses at one code reached the provider. The limit is 5.
- **Some requests are never rate limited.** Revoke and rotate with a valid proof have no limit at all. 403
  `write_denied` and 401 responses are never counted. Up to 9 MiB of request body is buffered before any
  authentication. Together these let any account holder, and for the last one anybody, load the database and memory
  without limit.
- **Five replays inside the window.** Beyond the two the implementer lists, a replayed enrollment create or recovery
  request brings back a request the user just rejected.
- **Smaller gaps:** IPv6 is keyed per /128; cross-site "simple" POSTs reach `/v1/auth/*`; a trailing slash gets a
  redirect whose Location comes from the Host header; expected unique-key violations write user ids into the
  Postgres log unless verbosity is terse; the pool acquire has no timeout; the default environment is `dev`.
- **Test gaps:** 8 of my 32 own mutants survive. The most important: nothing tests that a device-signed endpoint
  refuses a bare account session.

Verdict: **MERGE AFTER FIXES**. There are 3 small blocking items (§9).

## 1. What I ran

| Check | Result |
|---|---|
| Full suite in the scratch copy (`pytest -q`) | **336 passed** in 26 s (the same as the implementer's number) |
| `contract/py/test_contract.py` | 31/31 passed |
| `contract/tools/check_consistency.py` | 0 hard mismatches |
| The implementer's 45 mutants (`tests/mutation/run_mutants.py`, re-run in the scratch copy, without my probe file) | **45/45 killed**. The claim holds |
| My own 32 mutants (`review/my_mutants.py`, multi-replacement, the same runner logic, whole suite with `-x`) | 24 killed, **8 survived** (§5) |
| 13 probe tests of mine (`review/test_review_probes.py`; they assert what the server does today) | all behave as reported below |
| Differential fuzz: the server's `schema.Validator` against `sixkey_contract.validate` on 19 500 mutated request bodies from the wire examples, plus targeted texts | no case where the contract rejects and the server accepts; the reverse only for strict-JSON rules inside `EnvelopeText`/`BundleText` (S14) |
| `pip-audit -r requirements-dev.txt` (online advisory DB) | "No known vulnerabilities found" |
| Migrations applied from scratch, then again | second run: "(nothing to apply)"; `SHOW timezone` as `sixkey_api` on an `Asia/Kolkata` cluster = `UTC` |
| Privilege probe as `sixkey_api` | no access to `auth`, `sixkey_meta`, `pg_read_file`; **can** `CREATE TABLE/FUNCTION` in `public` and create TEMP tables (S11) |

All the scratch artefacts are under `scratchpad/m4-review/review/`:
`my_mutants.py`, `run_my_mutants.py`, `mutants.out`, `their_mutants.out`, `test_review_probes.py`, `fuzz/diff_validators.py`, `slash_probe.py`.

## 2. Confirmed findings

Severity reflects impact with the design's threat model (server zero-knowledge, email takeover is not vault takeover).
"Merge" = blocks merging M4; "M5" = blocks starting M5 (extension wiring against this server).

| ID | Sev | Where | Finding | Merge | M5 |
|---|---|---|---|---|---|
| S1 | Medium | `routes/auth.py:60-66` | OTP "5 attempts per code" is check-then-act across an `await` | **yes** (3 lines) | no |
| S2 | Medium | `main.py:46,51-52`; `pipeline.py:111-124,358-360` | valid-proof revoke/rotate have no limit at all; no byte budget on envelope writes | no | no |
| S3 | Medium | `pipeline.py:229-239,331`; `__main__.py:23` | up to 9 MiB buffered per request before any authentication; no concurrency cap | no | no |
| S4 | Low | `pipeline.py:376-377`; `routes/vault.py:157-171` | 401/403 never counted, so a device-credential holder has an unlimited rate of 8 MiB `write_denied` PUTs | no | no |
| S5 | Low | `pipeline.py:131-143`; `ratelimit.py:52-98`; `routes/auth.py:43-65` | IP keys per /128; IP-keyed ms timestamps kept up to 24 h (contract says TTL ≤ 1 h); unbounded keys and counters | no | no |
| S6 | Low | `pipeline.py:311-318` | Content-Type ignored, so cross-site simple POSTs to `/v1/auth/otp`, `/v1/auth/verify` work | no | no |
| S7 | Low | `routes/account.py:31-36`; `db.py:38-41` | account deletion racing a write deadlocks → 500 (known, A1) | no | no |
| S8 | Low | `routes/enroll.py:73-82,299-317`; `routes/vault.py:49-81`; `routes/devices.py:85-101` | expected unique/FK violations raise ERRORs whose DETAIL carries user_id/device_id unless the server log is terse | no | no |
| S9 | Low | `routes/enroll.py:62-83,269-276,282-319`; `routes/vault.py:205-219` | replays inside the 5-min window: 4 beyond rename (§6) | no | no |
| S10 | Low | `config.py:57`; `db.py:28-35` | `db_acquire_timeout_s` is never used; under pool exhaustion requests queue forever | no | no |
| S11 | Low | `migrations/0001_sixkey.sql:36-38` | `sixkey_api` can CREATE in `public` (PG14) and TEMP | no | no |
| S12 | Low | `config.py:93`; `main.py:150-153` | `SIXKEY_ENV` defaults to `dev`; the fake provider is refused only for an explicit `production` | no | no |
| S13 | Low | `main.py:163` | trailing-slash paths get a 307 whose Location is built from the Host header | **yes** (1 arg) | no |
| S14 | Low | `contract/py/sixkey_contract.py:171-177` | the test oracle parses `contentSchema` texts with lenient `json.loads` | no | no |
| T1 | Medium (test) | tests | no test sends a bare account session to a device/enroll-signed endpoint (mutant R01 survives) | **yes** (test only) | no |
| T2 | Low (test) | tests | no race test for clear-history, PUT /v1/keys × revoke, rotate × PUT /v1/keys (R10, R11, R24 survive) | no | no |
| T3 | Low (test) | tests | rotate's `bundle.by` check untested (R26); idempotency never tested with a MAC-only difference (R07); log values unchecked (R16) | no | no |

### S1 — OTP per-code limit races (Medium)

`verify` reads the per-email counter (`L.get(per_code) >= 5`, line 61), then `await provider.verify_otp(...)` (line 63),
and only increments after a wrong answer (line 65). With the FakeAuthProvider a wrong code returns before any `await`,
so M4 as shipped is not exploitable. `SupabaseAuthProvider` (M8) awaits an HTTP call, so all concurrent guesses pass the
check before any is counted.

Repro (`test_otp_per_code_limit_is_check_then_act`): request a code; wrap `provider.verify_otp` in an
`await asyncio.sleep(0.05)`; fire 40 different wrong guesses with `asyncio.gather`. Result: **40 reached the provider**
(limit 5).

What bounds it then is only `otp_verify_ip` (30/h per IP). That is per /128 (S5) and can be driven from other people's
browsers (S6). Supabase's own verify limit is per IP, and every call comes from the API's one IP, so the owner must
raise it (§5.6). It will not help.

Impact (by design): an account session, which lets the attacker squat on an email that has no vault yet (`init`),
spam enrollment requests and read has_vault/device count. It does not give the vault.

Fix: reserve before awaiting, `if L.incr(per_code) > lim.otp_verify_code: raise ApiError("otp_invalid")`, then call
the provider. A success needs no refund; a new send resets the counter as today. Add a test with a slow provider.

### S2 — no limit at all for valid-proof revoke and rotate; no byte budget (Medium)

`rotateKeys` and `revokeDevice` have `account_ceiling_exempt=True`. A valid `password_auth` sets
`device_exempt=True` (`pipeline.py:360`). Together, the request touches no bucket.

Repro (`test_valid_proof_revoke_and_rotate_have_no_limit_at_all`, contract-default limits): 700 revokes of an
already-revoked device in one minute → 700 × 200. Then 40 consecutive 1 MB rotations in the same minute → 40 × 200.
With 8 MiB envelopes that is unlimited WAL, history churn and CPU from any account holder: sign up, init, loop
rotate.

Plain PUTs are bounded per request, not per byte: 30/min per device × 8 MiB = 240 MiB/min, and 600/min per account,
about 4.8 GB/min of WAL.

S2's intent ("a clone without the password can never crowd out the owner's revocation or rotation") survives a
separate bucket. Invalid proofs never reach it; they stop in `bp:`.

Fix: add a per-account bucket used only by requests whose proof is valid (for example 60/min). Add a per-account
byte budget for envelope writes (PUT + rotate, for example 256 MiB/h → 429).

### S3 — unauthenticated 9 MiB bodies buffered before authentication (Medium)

`run()` reads the whole body (`read_body`, line 331) before the session, signature or even header-shape checks.
`__main__` runs uvicorn without `limit_concurrency` and without a body timeout.

Repro (`test_unauthenticated_9_mib_body_is_read_completely_before_any_auth`): a chunked 9 MiB−64 KiB PUT
`/v1/vault` with no Sixkey headers is consumed completely, then answered 401.

N such connections cost N × 9 MiB of RAM on a single small instance. An OOM restart also resets every in-memory rate
limit.

Fix:
- Before reading the body, check what needs no body: signer headers present and well formed, `Sixkey-Ts` inside the
  window, a bearer token that verifies (registration and step-up), and for the three 9 MiB endpoints the device row
  exists.
- Bound concurrent large bodies with a semaphore (e.g. 4–8).
- Set uvicorn `limit_concurrency`. Set body and idle timeouts at the proxy (M8).

### S4 — failing authenticated requests are free (Low)

Every 401/403 is refunded (line 376), by design (§5.5). A device credential without the password (a clone) can send
unlimited PUTs carrying 8 MiB envelopes and a wrong write proof. Each one is parsed, hashed, read from the database
and answered 403.

Repro (`test_write_denied_is_never_rate_limited`): 40 × 8 MB `write_denied` in one minute, no 429. 100
`bad_signature` requests with a known device id, no 429.

Fix: a separate non-refundable per-device failure bucket for `write_denied` and signature failures on an existing
device (e.g. 60/min). Valid-proof requests stay exempt, so S2/F8 still hold. Design change in §5.5.

### S5 — IP buckets (Low)

- `client_ip()` returns the full address. One IPv6 /64 gives 2^64 fresh `oi`/`vi`/`rai` buckets.
  Repro (`test_ip_buckets_are_per_128_and_live_past_one_hour`): `2001:db8::2` gets a fresh bucket after `::1` is
  exhausted.
- `Limiter._gc` deletes a key only when its newest entry is more than 24 h old. Expired entries are popped only on the
  next hit, so IP-HMAC keys keep exact millisecond request times until UTC midnight. The same probe shows them still
  present 2 h later. This contradicts the contract's `IP_COUNTER_TTL_S = 3600` ("TTL ≤ 1 h"). It is memory only, but
  the HMAC key sits in the same memory.
- `_counters` (per-email `ov`) and `_hits` grow without bound with attacker-chosen emails until midnight.

Fix:
- Key IPv6 by /64 (IPv4 by /32).
- Store each key's window and purge entries older than it on every gc pass.
- Cap the dictionaries (LRU), and on overflow answer 429 rather than grow.

### S6 — cross-site simple requests (Low)

`parse()` ignores Content-Type. A web page can send `POST /v1/auth/otp` with `Content-Type: text/plain` (no CORS
preflight). The browser cannot read the reply, but the side effect happens: an OTP email is sent from the visitor's
IP. The same works for `/v1/auth/verify` with `application/x-www-form-urlencoded`, which spends the victim's per-code
attempts.

Repro (`test_cross_site_simple_request_triggers_otp`): with `Origin: https://evil.example` the answer is 202, no ACAO,
and the code was sent.

This turns any popular page into a distributed OTP-spam (and, with S1, brute-force) source.

Fix: require exactly `application/json` on every request with a body (422 `invalid_request`; contract note). A
cross-origin JSON POST then needs a preflight, which the CORS layer already refuses for non-extension origins.

### S7 — deletion × write deadlock (Low, known)

Repro (`test_account_deletion_racing_a_put`): a PUT paused after its device lock; `DELETE /v1/account` meanwhile;
release. Result: PUT 200, DELETE **500** `internal_error`, nothing deleted. A retry works, as §5.7 says.

Fix:
- Map `DeadlockDetectedError` and `SerializationError` to 503 `unavailable` + Retry-After instead of 500. They are
  transient, and a client that treats 500 as a bug will not retry.
- Retry `delete_user` once server-side. At M8 the cascade runs inside GoTrue: map its 500 the same way.

### S8 — row data in the Postgres log (Low; blocks M8 unless verified)

`one_per_session`, `device_exists` and concurrent `vault_exists` are produced by catching unique violations.
`session_invalid` after a user deletion comes from catching FK violations. `one_per_session` is a normal client path.

Locally `log_error_verbosity = terse` hides the DETAIL. With the default verbosity I reproduced:
`DETAIL: Key (user_id, session_ref)=(11111111-…, \xabab…) already exists.`

`log_error_verbosity` is superuser-only, so it may not be settable on Supabase.

Fix: no expected ERRORs. Use `INSERT … ON CONFLICT DO NOTHING RETURNING` (or `ON CONFLICT ON CONSTRAINT …`) and
decide on the empty result. Keep the except clauses only as a race fallback.

### S9 — replays inside the window (Low)

See §6.

### S10 — no acquire timeout (Low)

Repro (`test_pool_acquire_has_no_timeout`, `db_pool_max=1`): with the only connection held, a status request is still
pending after 6.5 s. `db_acquire_timeout_s = 5` is never used.

Fix: one helper `acquire()` with `timeout=settings.db_acquire_timeout_s`, used by every handler (also instead of
`pool.fetch*`). `asyncio.TimeoutError` already maps to 503.

### S11 — least privilege (Low)

As `sixkey_api`: `CREATE TABLE public.evil` and `CREATE FUNCTION public.f()` succeed; `CREATE TEMP TABLE` succeeds.
Built-ins cannot be shadowed (pg_catalog is searched first, and every query is schema-qualified), so this is defence in
depth.

Fix: in the migration, `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (or at least from sixkey_api) and
`REVOKE TEMPORARY ON DATABASE … FROM PUBLIC` where acceptable. In `test_db_roles.py`, assert every schema/database
privilege of sixkey_api, including `public` CREATE and TEMP.

### S12 — fail-open defaults (Low)

`Settings.from_env` defaults `env` to `dev`. A deploy that forgets `SIXKEY_ENV` but has `SIXKEY_FAKE_AUTH_DSN` runs
the fake provider: codes in memory, and emails plus codes in a file if `SIXKEY_FAKE_INBOX_FILE` is set.

Fix: require `SIXKEY_ENV`. Allow the fake only for dev/test and a loopback bind.

### S13 — trailing-slash redirect (Low; blocks merge, 1-line fix)

FastAPI's default `redirect_slashes=True` answers `GET /v1/vault/` (any route + `/`) with **307
`Location: https://<Host header>/v1/vault`** (`review/slash_probe.py`). The answer has no contract error body and no
log line.

This is a Host-header-derived redirect. A client bug or a proxy that rewrites Host would send the extension, which
follows redirects by default with its Sixkey headers, to another host.

Fix: `FastAPI(..., redirect_slashes=False)` so these become the 404 `not_found` body. M5: `fetch(..., {redirect: "error"})`.

### S14 — the oracle is laxer than the server (Low)

`sixkey_contract.validate` checks `contentSchema` after `json.loads`. Inside `BundleText`/`EnvelopeText` it accepts
`"kver":2.0`, duplicate keys, `NaN`, 2^53+1, `\u0000` and lone surrogates. The server rejects all of these, correctly
per N20/A18.

So the "independent validator" cannot catch a server regression that stores or returns such texts.

Fix: use the vector-tested strict integer-token rule plus a duplicate-key hook in `validate` for
`contentMediaType: application/json`.

### Informational (no change needed, or design-level)

- **I1** Rotate does not require `device_names` to cover every device (A6). Confirmed: `device_names: []` → 200, all
  names stay under the retired VK. A device created concurrently (fork/complete during the rotate) also keeps an
  old-VK name. Names are cosmetic, and a revoked device cannot read them any more. Fine; state it in §5.4.
- **I2** JWT: `aud` as a list containing `authenticated` and a missing `role` are accepted; there is no `nbf` and no
  exp leeway. Harmless for Supabase tokens. Tightening is optional.
- **I3** The server stores `commit` but does not check `SHA-256("sixkey-enroll-commit|1|…")` at reveal (P1 assigns it
  to A). A keyless check at reveal would cost 1 hash and refuse a buggy N early. Optional.
- **I4** FastAPI hold at 0.141.1: confirmed, 0.142.0+ adds `opentelemetry-api>=1.44.0` (latest 0.143.3). The API by
  itself sends nothing, but it is an unwanted dependency, so the hold is sensible. Better: the app uses only routing,
  a lifespan and one exception handler. Plain Starlette (already pinned at its latest 1.8.0) would remove fastapi,
  pydantic, pydantic_core, annotated-doc, typing-inspection, and the risk of a frozen framework missing fixes. The
  request parsing never goes through FastAPI or pydantic today, so FastAPI-level advisories mostly do not apply. All
  other pins are the latest releases; pip-audit is clean.

## 3. Plausible / deployment-dependent (not reproducible in M4)

- **P1** Supabase OTP timing (new user created vs existing user) may differ measurably. The API's 202 is uniform.
  M8: measure; if needed, pad the response time to a constant.
- **P2** `SupabaseAuthProvider.jwt_keys()` will be called on every request. With "refetch JWKS on unknown kid", random
  kids become a fetch storm. M8: cache, and refresh at most once per N seconds.
- **P3** Behind a proxy without `SIXKEY_TRUSTED_PROXIES`, every client shares the proxy's IP buckets: 20 OTP sends/h
  for everybody (global DoS). Warn at startup when `env=production` and no proxy is configured. Also check that the
  chosen proxy appends the client as the rightmost X-Forwarded-For value.
- **P4** CDNs/proxies that normalize paths (e.g. Cloudflare URL normalization), merge duplicate headers or drop DELETE
  bodies fail closed (`bad_signature`). That is an availability issue only. M8 repeats N25 and a percent-encoded
  target through the real proxy.
- **P5** Slow bodies (slowloris): uvicorn has no body timeout. Needs proxy timeouts.
- **P6** No global quota: each account can hold about 72 MiB, and accounts are cheap (OTP + IPv6, S5).
  Supabase-side CAPTCHA is impossible without a contract change, because the API proxies `/otp`. M8: storage alarms,
  and decide on a global sign-up ceiling.

## 4. Area by area: what I attacked, and what is sound

**(1) Authentication and authorization.**
- The OPS table (`main.py:29-66`) matches all 29 operations' `x-sixkey-auth` (signer, account_session, pw_auth,
  write_proof, new_key_proof). I dumped and compared all of them. Every proof-requiring handler calls
  `enforce_proof()` (11/11).
- JWT checks:
  - ES256 only. `alg none` and HS256 with the public key are refused (tested).
  - kid must be in the JWKS. PyJWT refuses non-string kids (`InvalidTokenError`), so no unhashable-kid 500.
  - aud, iss, exp, iat (+60 s future skew), sub as a lowercase UUID, session_id as a UUID, `is_anonymous`, role.
  - Step-up: `sub == device's user` and `iat ≥ now − 600 s` (`routes/account.py:28`).
- FakeAuthProvider fidelity:
  - send creates an unconfirmed user for any address (202 always).
  - Codes are single use and replaced by a new send. Wrong and expired codes are indistinguishable.
  - Logout kills the refresh token at once; the access token lives to exp, exactly like a locally verified Supabase
    JWT. The refresh token never leaves the server.
  - delete_user is a hard delete.
- Signatures:
  - Host is the configured one, never the Host header.
  - The target is the ASGI `raw_path` + `query_string` (ASCII, no `|`, no CTLs); an empty `?` matches WHATWG.
  - The body hash covers exactly the received bytes.
  - P1363 only (86 b64url chars, 0 < r,s < n); DER refused; high-s accepted (no dedup depends on it).
  - Registration keys must be the exact 91-byte SPKI prefix plus an on-curve uncompressed point. P-256 has no small
    subgroups, and compressed or off-curve points are refused.
  - Order: verify before revoked (P6); window `abs() > 300 s`.
  - The enrolling signer equals the path rid. Exactly one of Sixkey-Device / Sixkey-Enroll is accepted. The
    registration header must equal the body's device_id.
- Duplicate headers: the first value is used consistently.
- Percent-encoding: the raw target is signed and the decoded path is routed. The signer chooses the raw bytes, so no
  confusion; `../` and case changes do not route.
- Revoked devices get 403 on every operation (the in-transaction re-check is on every write path). The 401
  `unknown_device` vs `bad_signature` oracle is per design (A29).
- The idempotent-before-proof ordering (A5) is **not an oracle**:
  - It compares the submitted text with the *current* stored text, which the same credential can read with
    `GET /v1/keys`.
  - A replayed captured bundle gets 200 only while it is still current, and nothing changes. Otherwise it gets 409,
    which the same credential learns from `GET /v1/keys` anyway.
  - It says nothing about texts submitted in the past. `==` is not constant-time, but no secret is compared.
  - The 200 skips the failure counter, which cannot help guessing because the answer does not depend on the password.
- pw_auth:
  - Constant-time verifier compare. Failures are counted only for the signing device and capped at 10 with one atomic
    UPDATE. A valid proof clears only the signer's counter (my R08 is killed). The 10/min invalid bucket is
    non-refundable and writes nothing.
  - Answers are 403 at any counter value; there is no lock and no oracle beyond right/wrong. Wrong password and
    unknown device are not comparable: 401 comes before any proof work.
  - The recovery_auth path uses the same counter. The KDF floor/ceiling (600 000 – 20 000 000, salt ≥ 16 B) is
    enforced on every bundle write through the schema.

**(2) Tenant isolation.**
- Every statement in `routes/*.py` and `pipeline.py` filters by the authenticated `user_id`, or by the signer's own
  `device_id`, or by a rid already bound to the signer/tenant. The global existence checks on device_id are
  128-bit-random and per design.
- `lock_devices` filters `user_id`. Rotate's `device_names` must all be locked rows of the account. `_gone_or` returns
  410 for foreign ids.
- Mutants R02/R03 (tenant filter removed in clear-history and the versions list) are killed by `test_isolation`.
- RLS is enabled with `USING (true)` for sixkey_api, as §5.3 C2 specifies. It is not a tenant boundary; isolation is
  in the code, and that is what the design asks.
- anon/authenticated/PUBLIC see nothing. The owner is NOLOGIN. The cascade works through RLS (tested).
- Gaps: S11 above; M8 must audit every Supabase schema.

**(3) CAS and key operations.**
- PUT pre-checks (rev = if_version+1, vaultId, checksum, size), then 409, then vk_mismatch, then the write proof
  (HMAC over vaultId|if_version|checksum, constant-time). Then one transaction: device lock + revoked re-check → CAS
  UPDATE with a CTE INSERT into history (atomic) → cursor → prune under the vault row lock.
- A write proof read outside the transaction is safe: a concurrent rotate changes version and vk, so the CAS fails.
- PUT /v1/keys and rotate:
  - kver range `if_kver < kver ≤ if_kver + 65 536` (vectors and edges tested).
  - Byte-identical idempotency, then 409, then proofs, then vaultId/vkId/`by`, then P4 by iv+wrapped.
  - Rotate CAS on version and kver, with verifiers and write_key swapped atomically, names re-encrypted, every
    enrollment voided and history pruned in the same transaction.
- Retention: newest 30 + day-lasts of today and the 29 previous UTC days + head; the cap never drops the head;
  serialized with PUT, rotate, clear-history and the daily job by the vault row lock.
- Clear history: proof, device lock, vault FOR UPDATE, keeps the head, `history_bytes` set exactly.
- Account deletion: step-up + proof, then one provider call; nothing is deleted on failure (tested); S7.

**(4) Enrollment.**
- Every advancing UPDATE/DELETE carries `expires_at > now` (respond, reveal, approve, complete); expired rows are
  deleted on access.
- Transitions only go forward. Identical retries of respond/reveal return 200; anything else is 409.
- A single approver, and only the responder may approve. `sig_pubkey_sha256` is checked against the stored
  `new_sig_pubkey`. The key and device id are fixed at create; reveal cannot change them; complete uses the stored
  ones.
- complete creates the device row last, deletes the request in the same transaction, and rolls back on
  `too_many_devices`. Race with reject: row locks serialize them, and the loser gets 410.
- One request per session, through the unique index (all states, recovery included).
- name_ct: approval path from approve, under the then-current VK (rotate voids the request, so a stale-VK name cannot
  land); recovery path at complete, checked against the current VK.
- Nobody can create a device without approval or a recovery code. The new device has no device row, so it cannot
  respond or approve. My R17–R20 and R29 are killed.

**(5) DoS / robustness.**
- Content-Length is checked, then the stream is counted (chunked too: my R27 is killed).
- Strict JSON:
  - Integer tokens within ±(2^53−1); no NaN/Infinity; duplicate keys refused (stricter than `JSON.parse`, safe).
  - NUL and lone surrogates refused. A BOM is refused.
  - `__proto__` is an ordinary key, so it gets 422 under `additionalProperties: false` and is kept verbatim inside
    bundles.
  - Nesting 100 000 deep parses; 9 M deep → 422, not a crash; `json.dumps` of the kdf survives the 64 KiB maximum
    depth.
- The validator's B64 fast path is the same language as the regex. `$` follows ECMA semantics in both validators.
  There are no `\d`/`\w` in any pattern (all ASCII classes), so the OTP `compare_digest` never sees non-ASCII.
- Lock order: I checked every write transaction (PUT, PUT keys, rotate, clear-history, rename, revoke, fork, respond,
  approve, complete, reject, reject-all, recovery, init, enforce_proof's own transactions, the daily job). Each takes
  device rows (sorted) → vault row → enrollment rows (sorted) or skips levels. The cascade is the only inversion (S7).
- Device cap: 200 unrevoked (complete and fork). Revoked rows are unbounded, but only the account's own password
  holder can create them.
- Findings: S2–S5, S10.

**(6) Logging and privacy.**
- One JSON line per request with `t` (s), `rid`, `route` (template), `method`, `status`, `ms`, `code`, plus `ref`
  and `exc` on 5xx. The Guard and the 404 handler log class names only.
- uvicorn: access log off, proxy headers off, no server header. Its `Invalid HTTP request` warning has no exc_info.
- No IP, UA, header value, body, token, email or id in any line (the suite's scan, plus mine).
- Postgres: terse locally, no parameters logged on error (S8 for Supabase).
- Times: hour for vaults, versions, devices.created_at and revoked_at; day for last_seen; minute for
  enrollments.created_at; expires_at rounded up to the minute (A13 is sound). R28 is killed.
- The fake inbox file holds emails and codes but is dev only (S12).

**(7) Migrations.**
- Idempotent (applied twice). A changed file is refused by its SHA-256.
- `ALTER ROLE … SET timezone='UTC'` is effective: verified as sixkey_api on an `Asia/Kolkata` cluster.
- Every query is schema-qualified, so the unpinned search_path is harmless.
- No role passwords in the file (M8 sets one).
- `GRANT REFERENCES ON auth.users TO sixkey_owner` and `GRANT sixkey_owner TO CURRENT_USER` work locally; whether
  Supabase's `postgres` holds the grant option on `auth.users` is the open M8 question (A26).

**(8) Tests.** See §5.

## 5. The test suite

The 45 implementer mutants are real, plausible bugs, and I re-ran them: **45/45 killed**. The runner counts any
failing test as a kill under `-x`, so a flaky test would count as a kill. I saw no sign of that: every kill (theirs
and mine) names a test that targets the mutated rule.

My 32 additional mutants (`review/my_mutants.py`): **24 killed, 8 survived.**

| # | Mutant | Result |
|---|---|---|
| R01 | device-signed GETs also accept a bare Bearer session when no Sixkey-Device header is sent | **SURVIVED** (T1) |
| R02 | tenant filter missing in DELETE /v1/vault/versions | killed (test_isolation) |
| R03 | tenant filter missing in GET /v1/vault/versions | killed (test_isolation) |
| R04 | PUT /v1/keys CAS on "stored kver < new kver" (stale if_kver accepted) | killed |
| R05 / R06 | kver jump bound off by one (both directions) | killed (vectors) |
| R07 | idempotent comparison ignores the last 60 chars (the mac) | **SURVIVED** |
| R08 | a valid proof clears every device's failure counter | killed |
| R09 | byte cap may drop the head | **SURVIVED** (equivalent unless `history_max_bytes` < one envelope) |
| R10 | clear-history without device lock / vault FOR UPDATE | **SURVIVED** |
| R11 | PUT /v1/keys without the in-transaction device lock / revoked re-check (C3) | **SURVIVED** |
| R12 | every 4xx except 429 refunded | killed |
| R13 | window one-sided (any past ts accepted) | killed |
| R14 | `alg: none` accepted in the session path | killed |
| R15 | CORS reflects any Origin | killed |
| R16 | the User-Agent value logged in `code` | **SURVIVED** |
| R17 | any device may approve | killed |
| R18 | complete ignores expiry | killed |
| R19 | reveal can be redone with other values | killed |
| R20 / R30 | device cap off by one (complete / fork) | killed |
| R21 | a revoked device can still GET | killed |
| R22 | X-Forwarded-For believed from any peer | killed |
| R23 | recovery buckets refunded on 403 | killed |
| R24 | rotate CAS without kver (lost update vs concurrent PUT /v1/keys) | **SURVIVED** |
| R25 | fork's Sixkey-New-Sig verified with the old key | killed |
| R26 | rotate does not compare `bundle.by` with the signer | **SURVIVED** |
| R27 | body limit from Content-Length only (chunked uncapped) | killed |
| R28 | history rows at ms precision | killed |
| R29 | enrolling signer not bound to the path rid | killed |
| R31 | write proof also accepted for if_version − 1 | killed |
| R32 | failure counter cap raised | killed (by the DB CHECK, as a 500) |

Tests to add:
- **T1:** for every device- and enroll-signed operation, a valid `Authorization: Bearer` with no Sixkey headers →
  401 `bad_signature`. Also for every account-only/registration operation, a device signature without a bearer →
  401 `session_invalid`.
- **T2:** pause-hook races for clear-history × PUT and × revoke, PUT /v1/keys × revoke (mirror of
  `test_revocation_committed_mid_put_stops_the_write`), rotate × PUT /v1/keys.
- **T3:**
  - `test_bundle_consistency_with_the_account[by]` for rotate.
  - An idempotency case whose texts differ only in `mac` (and only in `at`).
  - In `test_request_lines_have_only_the_allowed_fields…`, also assert the values: `code ∈ errors.STATUS`, `exc`
    matches `^[A-Za-z_][A-Za-z0-9_]*$`, `route` is one of the 29 templates or `-`, `method` is an HTTP method.
  - A `select_kept` unit test with a cap smaller than the head.

## 6. The open decision: replay cache

I confirmed both residuals the implementer lists (`test_replayed_reject_all_and_clear_history`):
- a captured `reject-all` replayed 1 min later killed a new legitimate request;
- a captured `DELETE /v1/vault/versions` erased 3 versions written after it.

There are three more that you should know about:

1. **Enrollment create replayed after a reject** (`test_replayed_create_enroll_request_after_reject_makes_a_phantom_request`).
   The unique row is gone after reject, so the replay inside the window, while the 15-min token is still valid,
   creates a new pending request with N's id, key and commit. The replayer cannot advance it (no key), but it shows up
   on A as pending.
2. **Recovery enrollment replayed after reject-all** (`test_replayed_recovery_enrollment_after_reject_all`). It
   recreates an approved recovery request and returns the envelope + bundle to the replayer.
3. **Signed GETs** (`/v1/vault`, `/v1/keys`, versions) replayed within 5 min return ciphertext and the wrapped keys,
   which are material for offline password guessing. This matters only against someone who logs request headers but
   not responses.

All of them need a captured TLS-protected request. None breaks confidentiality of plaintext or integrity of the vault;
the effects are a few minutes of enrollment DoS, loss of minutes of history the user had just asked to delete, a
phantom pending request, and ciphertext to a header logger.

**Recommendation: do not add the in-memory nonce cache.** Accept and document all five residuals (with rename) in §1.2
A6 / §10 #41 and SECURITY.md.

Reasons:
- **It turns legitimate retries into errors.** Chromium retries a request whose reused keep-alive socket failed. If
  the server had processed it, the cache answers 401, which clients treat as an authentication failure (§3.10 stops
  syncing on 401 `unknown_device`; `bad_signature` would need new handling). An already-correct 409/200 becomes a
  false alarm.
- **It is not a guarantee.** It lives in one process: a restart or a second instance reopens the window. It also adds
  memory and state for an attacker who already defeated TLS.
- **Two residuals can be closed without it, and without a contract change, if you want:**
  - `reject-all` deletes only requests with `created_at ≤ minute_floor(signed ts)`. A replay then cannot touch
    requests opened after the original, except in the same minute.
  - `createEnrollRequest` and `enrollWithRecovery` refuse a signed `ts` older than the session's newest deleted
    request for the same `session_ref`. This needs state, so I would not.
  - Only the first is worth a line of code.

The hosting rule "never log request headers or bodies" (§5.6) remains the real control for (3).

## 7. The implementer's departures and A-items

- **FOR NO KEY UPDATE instead of FOR SHARE, and the fixed lock order device → vault → enrollment (A1): correct.**
  FOR SHARE followed by an UPDATE of the same row deadlocks two clones. M35 reproduces it. NO KEY UPDATE still
  conflicts with the revoking transaction's UPDATE, so C3 holds for PUT (M14 is killed); for PUT /v1/keys and
  clear-history the same code is untested (T2). The order holds in every transaction I traced (§4.5). §5.3 should be
  changed as A1 proposes.
- **`enrollments.name_ct` (A3): sound.** It is stored only between approve and complete, deleted with the row, under
  the current VK, and voided by rotate.
- **Cascade deadlock (A1 residual): acceptable** with the S7 mapping to 503 + retry.
- **No replay cache (A2):** §6.
- **A5** (idempotency before proofs): sound, §4.1.
- **A13** (expires_at rounded up to the minute): sound.
- **A17** (complete retry → 410, D4 recovery through a devN-signed status): correct. §3.2 M7's "complete is
  idempotent" must be reworded, and M5 must implement the status fallback on 410 after an uncertain complete.
- **A21** (per-session buckets): sensible.
- **A22** (per-email "per code"): sensible, but racy (S1).
- **A28** (unreachable `no_vault`): keep it as defensive.
- **A30:** M3/M5 must run the TS contract tests against `make run`.

## 8. What M8 (Supabase) must verify

1. **Signing keys and JWKS.** The project uses an asymmetric **ES256** signing key; the legacy HS256 secret is never
   accepted. Issuer string exact. JWT expiry = 900 s. Anonymous sign-ins disabled. JWKS cached, with a rate-limited
   refresh on unknown kid (P2).
2. **Local token verification.** Tokens are verified locally via JWKS, **never** via `GET /auth/v1/user`: the session
   is logged out at once by design, so `/user` would reject it.
3. **OTP flow.**
   - Template `{{ .Token }}` only; OTP length 6.
   - A new OTP invalidates the previous one. Supabase's own "once per 60 s" resend limit and every Supabase 4xx/429
     map to a response that never reveals whether the email exists.
   - Measure new-vs-existing timing (P1).
   - `create_user: true`. No client IP forwarded to Supabase.
   - Supabase per-IP send/verify limits raised for the API's single IP, **and S1 fixed first**.
4. **Refresh token after logout.** `logout?scope=local` right after verify; prove with the real project that the
   refresh token is dead.
5. **User deletion.**
   - Admin delete is a hard delete (`should_soft_delete=false`).
   - The cascade empties every sixkey row under RLS when run by GoTrue's role.
   - Deletion racing a write → 503 + retry (S7).
   - `purge_unconfirmed` implemented (admin API or SQL) and scheduled daily with the retention job (cron/pg_cron);
     counts only in its output.
6. **Running the migration on Supabase.**
   - Run `0001_sixkey.sql` as `postgres`.
   - `GRANT REFERENCES ON auth.users TO sixkey_owner` must succeed (auth.users is owned by `supabase_auth_admin`;
     `postgres` needs the grant option), or adopt a fallback (A26).
   - `GRANT sixkey_owner TO postgres` works.
   - `sixkey` is **not** in the API's exposed schemas.
7. **Privilege audit as `sixkey_api`.** Query `has_schema_privilege` and `has_table_privilege` over every schema
   (`auth`, `storage`, `vault`, `extensions`, `graphql`, `realtime`, `public`, `sixkey_meta`) plus database CREATE and
   TEMP (S11). Also check that `anon`/`authenticated`/`service_role` have no USAGE on `sixkey`. Run
   `tests/test_db_roles.py` and `test_migrations.py` against the project.
8. **Connection.** `sixkey_api` password set out of band. Connect through Supavisor transaction mode
   (`sixkey_api.<ref>`, port 6543) with `statement_cache_size=0`. Prove the UTC role setting through the pooler
   (`test_api_sessions_are_utc…`).
9. **Postgres logging.**
   - `log_error_verbosity = terse` actually settable and set; otherwise S8 becomes mandatory.
   - `log_parameter_max_length_on_error = 0`, `log_statement = none`, pgaudit off for sixkey_api.
   - Verify by provoking `one_per_session` and reading the Supabase log explorer.
10. **Hosting.**
    - Access logs off or without IPs.
    - Exactly one instance (the limiter is in memory) or Redis.
    - `SIXKEY_TRUSTED_PROXIES` = the proxy, and that proxy appends the client as the rightmost X-Forwarded-For value
      (P3).
    - IPv6 keyed by /64 (S5).
    - Body size, body timeout and idle timeout at the proxy (S3, P5).
    - No URL normalization and no header merging; DELETE bodies forwarded. Re-run N25 and a percent-encoded target
      through it (P4).
    - TLS.
11. **Configuration.** `SIXKEY_ENV=production` (S12), `SIXKEY_API_ORIGIN` = the exact public host,
    `SIXKEY_CORS_ORIGINS` = store ID (+ dev ID), `min_client_version`.
12. **Disclosure.** Backup/PITR windows disclosed (§5.7). Supabase auth audit logs hold the server IP and emails
    (PRIVACY).

## 9. Verdict

**MERGE AFTER FIXES.**

Must fix before merge (all small):
- **S1:** reserve the OTP attempt before awaiting the provider, plus a slow-provider test.
- **S13:** `redirect_slashes=False`.
- **T1:** the weaker-credential tests.

Should follow before M8 and public launch: S2, S3, S5, S6, S8 (or verified terse logging), S7, S10, S12. The rest
are low or test-quality items. None blocks M5: M5 runs against the fake provider on loopback, where S1 is not
exploitable and the DoS items do not matter.

Counts: critical 0, high 0, **medium 4** (S1, S2, S3, T1), **low 13** (S4–S14, T2, T3), informational 4 (I1–I4).

Top 3:
1. **S1:** OTP per-code limit is check-then-act. Becomes a practical OTP brute force with the Supabase provider,
   amplified by S5 and S6.
2. **S2:** valid-proof revoke/rotate are completely unlimited, and envelope writes have no byte budget. Any account
   holder can flood the database.
3. **S3:** 9 MiB bodies are buffered before any authentication with no concurrency cap. Unauthenticated memory DoS
   on a single in-memory-limiter instance.
