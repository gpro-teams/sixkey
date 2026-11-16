# M4 re-review: the fix delta

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading and the first paragraph, repository paths updated to the current layout and
> absolute local paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes,
> mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was
> adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these
> records: [`docs/audit/README.md`](../README.md).

Scope: the M4 fix pass in `api/server/` (uncommitted; repo has no commits) that resolves the first
review `docs/audit/internal-reviews/M4-REVIEW.md` (S1-S14, T1-T3, I2) and resyncs to the revision-15/16 contract. Reviewed
against `docs/SYNC-DESIGN.md` §0.0o/§0.0p and §5, `api/openapi.yaml` (revision 16), `contract/`,
`docs/design/notes/M4-NOTES.md` §9/§10, and the first review `docs/audit/internal-reviews/M4-REVIEW.md`.

Review only: no file in the repository was changed except this one. All experiments ran in a scratch copy
(`…/scratchpad/m4-rereview/`, its own venv, its own Postgres 14 on 127.0.0.1:55438; the main tree's
`.pg/` was never touched — the scratch copy's `scripts/pg.sh`/`Makefile`/`pgutil.py` were switched to
TCP 55438 because the scratch socket path exceeds Postgres's 103-byte limit).

## 0. What I ran (scratch copy)

| Check | Result |
|---|---|
| Full suite `pytest -q` | **450 passed** in 43 s |
| `make test-long` (400 model programs) | **1 passed** in 36 s |
| `contract/py/test_contract.py` | **36/36** passed (incl. the 4 strict counterexamples, strict-parser table, `test_every_operation_lists_413`) |
| `contract/tools/check_consistency.py` | **0 hard mismatches**, 0 accepted deviations |
| `pip-audit -r requirements-dev.txt` | **No known vulnerabilities** (only fastapi held behind latest, on purpose) |
| My 22 own mutants of the fix code | **21 killed, 1 "survived"** (X18, a test gap — see §3) |
| My 9 attack probes (`rr/.../tests/test_rr_probes.py`) | all behaved as reported below |
| S12 CLI matrix + raw-socket `limit_concurrency` test | run live (see RR5, §4 S12) |
| Live uvicorn (`python -m sixkey_server`, real TCP, FakeAuthProvider) | full signed flow + 20 wire-example bodies replayed over real HTTP, every response validated by the **independent** `contract/py` validator; healthz 200, trailing-slash 404 with no Location, Host header ignored, over-limit 413, text/plain 422 |

Scratch artefacts: `…/scratchpad/m4-rereview/rr/` (`my_mutants.py`, `run_my.py`, `my_mut.log`,
`live_http.py`, `server.log`) and `…/api/server/tests/test_rr_probes.py`.

The three first-round blockers are fixed and verified: **S1** (OTP attempt reserved before the provider
await; `routes/auth.py:62`), **S13** (`redirect_slashes=False`; `main.py:165`), **T1** (weaker-credential
matrices; `test_review.py`). The contract resync (rev 15/16) matches the server: the new 413 pairs,
`MinuteMs`, `proof_valid_account`/`device_envelope_bytes`/`account_envelope_bytes`/`session_*` limits,
the Content-Type rule, the aud/role wording, and the 503 sources are all present in `api/openapi.yaml`
and observed by the suite.

## 1. Verdict

**MERGE.** The fix pass is sound. Every first-round blocker is fixed and independently verified; the
131-mutant claim holds (see §3); the contract resync is consistent; no authentication, isolation, CAS,
enrollment, logging or migration regression was found. The new findings are one medium and three low,
all availability/accounting/test-quality items that are already M8-gated or documented; none blocks
merging M4 and none blocks M5 (M5 runs on loopback against the fake provider, where none is exploitable).

- Counts: **critical 0, high 0, medium 3 (RR2, RR5, RR6), low 3 (RR1, RR3, RR4).** All three mediums are
  availability-only, and all are either documented residuals (RR2, RR5=design P5) or consequences of the
  accepted contract rate numbers (RR6); none is a correctness or confidentiality bug in the fix code.
  They must be closed before **public launch (M8)**, not before merge or M5.
- Top 3:
  1. **RR5** — a directly-exposed uvicorn is denied wholesale by **unauthenticated idle TCP sockets**.
     With `limit_concurrency=8`, 8 sockets that send nothing make `/healthz` return 503, and the server
     never closes them (`timeout_keep_alive` governs only post-request keep-alive). The fix's own
     `limit_concurrency` (default 256) is what turns idle sockets into a service-wide outage. Design P5;
     the only control is the M8 reverse proxy. **Confirmed live.**
  2. **RR6** — the email-/IP-keyed OTP buckets are fillable with **no authentication** to lock a victim
     out. Any IP can burn a victim's current code with 5 wrong verifies (`ov:<email>` is email-only), and
     many IPs can fill `oe:<email>` (50/day) so the victim's own send is 429 for ~24 h. This denies
     recovery-code enrollment, new-device enrollment, init and step-up deletion. Follows from the contract
     numbers + A22; a design/owner decision. The device/account/session buckets are **not** vulnerable
     (they are charged only after the signature verifies). **Confirmed.**
  3. **RR2** — the 8 large-body slots are one global pool; a single identity (any device id, or an OTP
     session for init) denies every other account's `PUT`/`init`/`rotate`, and slowloris bodies are
     bounded only per-request (60 s), not in aggregate. Documented residual; the M8 checklist
     under-specifies the mitigation.

  (RR1 — byte-budget accounting gap; RR3 — counter-table 429 divergence; RR4 — XFF test gap — are low.)

## 2. Findings

Severity uses the design's threat model (server zero-knowledge; a "clone"/copy holds a device signing
key but not the password/VK; email takeover is not vault takeover).

### RR1 — envelope byte budgets bypassed on rotate (422) and never charged on init (Low)

`pipeline.run()` charges the rate buckets at two different points. For `proof != "none"` operations it
calls `parse()` *before* `charge()` (`pipeline.py:440-449`); for `proof == "none"` (`PUT /v1/vault`) it
charges *before* `parse()` (`pipeline.py:437-439`). The byte-budget charge lives in `charge()`
(`pipeline.py:139-143`) and only runs for `self.device is not None` envelope ops.

Consequences:
- **rotate + malformed body → free.** A clone (has the device signing key, not the password) sends an
  8 MiB `POST /v1/keys/rotate` whose `envelope` text violates strict JSON (e.g. a duplicate key). The
  signature verifies (real key), then `parse()` raises `invalid_request` (422) before `charge()` runs,
  so neither `eb:` (device byte budget), `dw:` (device writes) nor `ab:` (account byte budget) is
  charged. 20 MB of such rotates against a 3.2 MB budget all return 422 with the budget counters at 0
  (`test_rr_probes.py::test_P1_rotate_422_bypasses_the_device_byte_budget`). A *well-formed* rotate that
  ends in `write_denied` does pay `eb` — so the budget protects the `403` path but not the `422` path.
- **init → never charged.** `initVault` is `REGISTRATION`, so `ctx.device is None`; `charge()` never
  reaches the byte-budget block. After an init with an envelope, both `ab:` and `eb:` counters are 0
  (code-confirmed and probed), although `api/openapi.yaml` lists `POST /v1/vault/init` under
  `device_envelope_bytes.applies_to` **and** `account_envelope_bytes.applies_to`.

Impact is bounded: these requests never write the database (422/registration fail before any
transaction), and the 8 MiB reads are bounded by the global large-body slots (RR2), the 60 s body
timeout and session/device request buckets. So the DoS magnitude equals the already-documented S3
residual. But it is a correctness gap between the fix and its own contract text ("failed requests count
too… every envelope write").

- File:line: `pipeline.py:139-143`, `pipeline.py:437-449`, `routes/keys.py:67-91` (rotate), contract
  `api/openapi.yaml` rate-limit entries `device_envelope_bytes`/`account_envelope_bytes`.
- Repro: `tests/test_rr_probes.py::test_P1_rotate_422_bypasses_the_device_byte_budget` (20 × 8 MiB
  rotates, all 422, `eb`/`dw` = 0); init: `count("ab:"+uid)==0 and count("eb:"+dev)==0` after a vault.
- Fix: for `max_body == MAX_BODY_BYTES_VAULT`, charge `eb`/`ab` right after `read_body` (before `parse`,
  as `PUT` already does), and refund `eb` when the proof turns out valid (keep the existing `ab` refund
  on 401/403). Charge `init`'s envelope against `ab` (it has no device, so `eb` is N/A — or document
  that init is exempt and correct the contract's `applies_to`).
- blocks-merge: **no.** blocks-M5: **no.** (Fold into the "before M8/launch" list.)

### RR2 — the large-body slots are one global pool; cross-account write DoS (Medium)

The 9 MiB endpoints (`init`, `PUT /v1/vault`, `rotate`) share one process-wide semaphore of
`large_body_slots = 8` (`pipeline.py:72-76,303-307,431-433`; `config.py:65-66`). The slot is taken after
the signer *row* is looked up (`find_device`: the device exists) but **before** the signature is
verified (`verify_signer` runs after `read_body`). So:

- Any account can deny any other account's large writes. With `large_body_slots=1`, while account A holds
  the slot, account B's `PUT` gets `503 unavailable`
  (`test_rr_probes.py::test_P2_slots_are_global_across_accounts`).
- Holding a slot needs only a *known device id* (not a valid signature): a bogus-signature 8 MiB PUT from
  a second device still occupies the slot for the whole body read
  (`test_rr_probes.py::test_P2b_slot_taken_before_signature_is_verified`). For `init` an OTP session is
  enough — broader than the "device-id holder" the notes describe.
- The 10 s slot wait and 60 s body timeout bound each *request*, not the *aggregate*: 8 connections
  cycling every ≤60 s (slowloris within the timeout) keep all 8 slots busy continuously and deny every
  large write platform-wide, for every user.

This is the documented S3 residual (M4-NOTES §9.1 S3), and the app cannot fully prevent it alone. But the
current M8 checklist item 10 lists only "body size, body and idle timeouts", not a per-IP/per-account
connection cap or a proxy concurrency limit, which is what actually bounds this.

- File:line: `pipeline.py:303-307,431-433`; `config.py:65-67`; `__main__.py:35` (`limit_concurrency`).
- Repro: `test_P2_slots_are_global_across_accounts` (account B → 503 while A holds the only slot) and
  `test_P2b_slot_taken_before_signature_is_verified` (a known device id with a shape-valid-but-wrong
  signature and an 8 MiB body gets 503 — it waited for a slot and failed *before* the signature was
  checked). Both pass.
- Fix: in-app, prefer per-source (IP or account) slot fairness over one global pool, or move the slot
  behind the signature check for device ops (the body still has to be read to verify, so this only helps
  bad-signature cases). Primarily an M8 deployment control (see §4). Set `limit_concurrency` and a short
  proxy header/body read timeout and per-IP connection cap.
- blocks-merge: **no.** blocks-M5: **no.** blocks-M8/launch: **yes** (checklist fix).

### RR3 — counter-table-full returns `otp_invalid`, not the `429` the contract's limiter rule states (Low)

The limiter has two tables, both capped at `limiter_max_keys` (200 000). `hit()` correctly answers `429`
when the `_hits` table is full (`ratelimit.py:85-86`). But the OTP per-code counter uses `incr()`, which
on a full `_counters` table returns the sentinel `1 << 30` (`ratelimit.py:149-150`); `routes/auth.py:62`
then compares `incr(...) > otp_verify_code` and raises `otp_invalid` (401). The contract's own rule
(`api/openapi.yaml` rate-limit rules: "a request that needs a new key once a table is full gets 429
rate_limited") therefore does not hold for the `_counters` table.

`_counters` holds only attacker-chosen `ov:<email>` keys; filling it (200 000 distinct emails verified
within the 1 h counter TTL) makes every *new* email's first verify return `otp_invalid` instead of 429 —
a login-availability DoS, bounded by the `vi`/OTP-send buckets, the 1 h gc and the UTC-midnight key
rotation, but still a code/contract divergence.

- File:line: `ratelimit.py:141-152` (`incr`), `routes/auth.py:62`; contract rule in `api/openapi.yaml`
  (`x-sixkey-rate-limits.rules`, "Each limiter table holds at most 200000 keys… gets 429").
- Repro: `tests/test_rr_probes.py::test_P3_counter_table_full_returns_otp_invalid_sentinel_not_429`
  (`incr` returns `1<<30`); `test_P3b_full_hits_table_evicts_fresh_device_buckets` shows the `_hits` side
  correctly 429s and evicts a victim device bucket.
- Fix: on `incr` overflow, signal exhaustion the same way `hit` does, and have `verify` raise
  `rate_limited` (429 + Retry-After) rather than `otp_invalid`. (Also consider per-key-family caps so IP/
  email keys cannot evict device buckets — RR3b below.)
- blocks-merge: **no.** blocks-M5: **no.**

#### RR3b — shared per-table cap lets cheap IP/email keys evict device limiter state (Low, by-design residual)

Both families share one `_hits` table; once it is full of foreign `oi:`/`vi:`/`oei:` keys an idle
device's next `dw:`/`dr:` bucket is refused with 429
(`test_P3b_full_hits_table_evicts_fresh_device_buckets`). This is the implementer's chosen
"refuse-rather-than-grow" behaviour and is bounded (gc to the window, daily key rotation), but a
determined IPv6 attacker (one /32 → 2^32 /64s) can sustain it. M8 mitigation: Redis / per-family caps
(already "one instance or Redis" in the checklist; add per-family caps).

### RR4 — X-Forwarded-For rightmost-of-multiple-values is untested (Low, test gap; spoofing-relevant)

`client_ip()` believes a single `X-Forwarded-For` header only from a trusted proxy and takes its
*rightmost* comma value (`pipeline.py:157-161`), which is correct for a proxy that appends the real
client. My mutant **X18** changed `[-1]` (rightmost) to `[0]` (leftmost, attacker-controlled) and
**survived the whole suite**: no test sends a multi-value XFF (`spoofed, realclient`), so a regression to
the spoofable leftmost value — which would let any client behind the proxy forge its rate-limit identity
— would not be caught. The shipped code is correct; the behaviour is unverified.

- File:line: `pipeline.py:157-161`; gap in `tests/test_limits.py::test_forwarded_for_only_from_a_trusted_proxy`
  (only ever sends a single-IP XFF).
- Fix (test): from a trusted proxy send `X-Forwarded-For: 203.0.113.9, <realclient>` and assert the
  limiter keys on the rightmost. M8: verify the chosen proxy appends the client as the rightmost value
  (already P3, but tie the server test to it).
- blocks-merge: **no.** blocks-M5: **no.**

### RR5 — unauthenticated idle-socket denial of a directly-exposed uvicorn (Medium)

The S3 fix added `limit_concurrency` (`__main__.py:35`, default 256, F14). With a live server at
`SIXKEY_LIMIT_CONCURRENCY=8`, I opened 8 raw TCP sockets that **send nothing at all** (also tried 8 that
send a partial request line with no final CRLF), waited > 6 s, and `GET /healthz` returned
`503 Service Unavailable`. The server did **not** close any of the idle sockets (0 of 8), because
uvicorn's `timeout_keep_alive = 5` only bounds the idle period *between* completed requests on a
keep-alive connection, not the initial request/header read. So `limit_concurrency` idle connections (256
by default) deny the entire service to everyone, with no credentials and no request.

This is the design-level slowloris residual (SYNC-DESIGN P5 "uvicorn has no body timeout… needs proxy
timeouts"), but it is stronger than "body": it needs no body and no partial request, just open sockets,
and the fix's own `limit_concurrency` is the amplifier. It is the most severe DoS I found, and the only
control is the M8 reverse proxy.

- File:line: `__main__.py:33-35` (`limit_concurrency`, `timeout_keep_alive=5`, no header-read timeout).
- Repro: `rr/` raw-socket test — 8 idle sockets → `/healthz` 503; sockets not closed by the server.
- Fix: M8 — never expose uvicorn directly; the reverse proxy must enforce a request/header read-idle
  timeout and a per-IP concurrent-connection cap, and `limit_concurrency` must be sized above the proxy's
  own connection cap. No in-app fix is sufficient alone.
- blocks-merge: **no.** blocks-M5: **no** (loopback). blocks-M8/launch: **yes.**

### RR6 — email-/IP-keyed OTP buckets are fillable without authentication to deny a victim (Medium)

The brief asks whether any limiter keyed by an attacker-controllable identity can be filled to deny a
victim. Answer: the **device/account/session/byte** buckets are safe — `dw:`, `dr:`, `aw:`, `ar:`, `eb:`,
`ab:`, `pv:`, `sw:`, `sr:` and `bp:` are all charged only after `verify_signer`/the account session, so a
claimed device id or account is never charged before its signature is proven. But the **email- and
IP-keyed OTP buckets are charged with no authentication at all**, and two of them let any attacker deny a
specific victim:

- **Code kill.** `ov:<email>` (5 attempts) is keyed by email only. An attacker from any IP spends the
  victim's 5 verify attempts against the current code; the victim's own correct code then returns
  `otp_invalid` (`test_rr_probes.py::test_P9_code_kill_any_ip_can_burn_a_victims_otp_code`). The victim
  must request a new code, which the attacker can burn again.
- **Send lockout.** `oe:<email>` (50/day, across all IPs) is fillable from ~17 IPs (3 per IP per 10 min
  via `oei`); once full, the victim's own send from a fresh IP is `429` until the 24 h window frees, and
  the victim receives ~50 emails (`test_P9b_send_lockout_many_ips_fill_the_per_email_day_bucket`, shown
  with a reduced `oe` limit).

Together these deny every account-session entry point for the target email: recovery-code enrollment
(the one that matters most), new-device enrollment, init and step-up account deletion. This is not a
fix-delta regression — it follows from the contract's rate numbers and A22 — but it is an unauthenticated,
targeted, ~24 h denial that the owner should decide on before launch.

- File:line: `routes/auth.py:43-50,57-62`; `config.py:22-27`; the limiter keys in `ratelimit.py`.
- Repro: the two `test_P9*` probes above (both pass).
- Fix: owner decision (M8/launch). Options: a CAPTCHA/Turnstile before `send`/`verify` (hard today
  because the API proxies `/otp`; a contract change), a per-email verify-failure policy that does not let
  an unauthenticated third party exhaust the code, or accept and document it. Tie to P6 (global sign-up
  ceiling) and P1.
- blocks-merge: **no.** blocks-M5: **no.** blocks-M8/launch: **owner decision.**

## 3. Tests and mutants

- **450 tests pass; `make test-long` (400 programs) passes; `contract` 36/36; checker 0 mismatches;
  pip-audit clean.** Every response in the suite is validated by the independent `contract/py` validator
  via `sk.check_response` (status/code lists, error-body shape, Retry-After on 429/503, strict nested
  texts). I reproduced all of this.
- **My 22 own mutants of the fix code: 21 killed, 1 "survived."** The killed cover: S1 revert
  (check-then-act) and OTP reset-on-verify; the valid-proof bucket skipped for revoke/rotate; byte budget
  made refundable / not charged; slot released early; IPv6 per /128 and mapped-IPv4 not normalised;
  Content-Type and charset checks removed and Content-Type skipped for DELETE; `SerializationError`
  dropped from the 503 set; deletion not retried; init's `ON CONFLICT` dropped; the 0002 PUBLIC revoke
  removed; fake provider allowed in production; aud exact-check removed; `is_anonymous` check removed;
  body timeout applied per-chunk instead of whole-read (drip-fed body); reject-all `minute_floor→
  minute_ceil` **and** `<=`→`<` (the mutant the brief names: killed by
  `test_enroll.py::test_reject_all_counts_open_requests_and_voids_recovery_ones`, so the bound is tested).
  The one survivor is **X18** (RR4). Each kill named a test that targets the mutated rule.
- **The implementer's "131/131 killed" is credible.** I re-ran the suite and checked the advisor's
  concern that F02 (OTP reset) and F12 (slot never returned) are attributed to `test_cas` only
  incidentally. F02 **does** have targeted coverage: run against its intended test alone it is killed by
  `test_limits.py::test_otp_verify_five_attempts_per_code` (which re-sends a code and expects the fresh
  5). The slot-return path is covered too: my dual mutant **X06** ("release the slot early") was cleanly
  killed by `test_review.py::test_large_body_requests_wait_for_a_bounded_number_of_slots`. The "killed by"
  column in M4-NOTES §6 is simply the first failure under `-x` in collection order (often `test_cas`),
  not a missing targeted test. **One caveat to M4-NOTES §6's "no mutant hung":** applying F12 (slot never
  released) and running only the slot test *hung* rather than failing fast in my environment (I stopped
  it at 120 s); under the full `-x` suite it is killed earlier by `test_cas`, so the claim holds there,
  but the slot test can hang when the slot is never returned.
- **Test gap:** RR4 (the XFF rightmost-of-multiple-values). The brief-named reject-all `<=`→`<` and the
  drip-fed-body mutants are **not** gaps — they are killed.

## 4. Area-by-area: what is sound

- **S1 (OTP).** The attempt is reserved with `incr` *before* `await verify_otp` (`routes/auth.py:60-63`),
  keyed per email HMAC and per the daily key; 40 concurrent wrong guesses reach the provider exactly 5
  times; a dead code is refused without asking the provider. The "new code resets the counter" (A22) is
  bounded by the OTP-send buckets (`otp_send_email_day` 50/day etc.), so the reset is not a practical
  brute-force amplifier (my `test_P8` shows 5+reset+5 = 10 reach the provider, but each code still costs
  a rate-limited resend that also emails the victim). **Sound.**
- **S2 / S4.** A per-account `pv:` bucket (60/60 s) covers valid-proof revoke/rotate; invalid proofs stop
  in `bp:` and never reach it; the device byte budget is non-refundable and valid-proof requests are
  exempt. The only hole is RR1 (422/init). The S4 declension of a `bad_signature` bucket is justified
  (anyone knowing a device id could fill it to lock the real device out). **Sound apart from RR1.**
- **S3 ordering.** Everything bodiless (Content-Length, Content-Type, session, signer-header shape,
  signer row) is checked before `read_body`; signature verify → revoked → ±300 s window stay after the
  body (the signing input hashes the body, so the body must be read to verify). An unauthenticated client
  (no session, no existing device/enrollment row) is rejected before any body is read. The residual
  (known device id → body read before signature) is RR2. **Matches the design.**
- **S5.** IPv6 keyed per /64, IPv4-mapped normalised to IPv4, IPv4 per /32; gc prunes each key to its
  window (≤1 h for IP keys) at least every 60 s / 256 ops; both tables capped (refuse past the cap).
  Forged `X-Forwarded-For` is ignored unless the peer is a trusted proxy and there is exactly one XFF
  header (duplicate headers fail closed to the peer). Caveats RR3/RR3b/RR4. **Sound.**
- **S6 (Content-Type).** `application/json` required (case-insensitive, `charset=utf-8` allowed, any
  other charset refused) on every body operation, before the body. Does not break legitimate clients:
  the test client and the contract send `application/json`; `DELETE /v1/vault/versions` with a JSON body
  passes; CORS preflight is answered by the `Cors` ASGI layer (204 to `OPTIONS`) before the pipeline, so
  it is not subject to the check; cross-site `text/plain`/form POSTs get 422 and send no OTP. **Sound.**
- **S7 (deletion).** Deadlock/serialization → 503 + `Retry-After: 5` (`db.py:20-31`); `delete_user` is a
  single cascade DELETE (atomic; a rollback deletes nothing); `DELETE /v1/account` retries once after
  50 ms then 503 (`routes/account.py:32-44`). No loop, no half-apply. **Sound.**
- **S8 (`ON CONFLICT DO NOTHING` at six sites).** init vault (concurrent init re-decides → still 201 or
  vault_exists), init device (→ device_exists, rolls back), complete device (→ enroll_state, request
  survives), fork device (→ device_exists), enrollment create and recovery (→ one_per_session). No lost
  update, no duplicate, and the response code does not depend on which account owns the conflicting
  (random) id, so no information leak. The `UniqueViolation`/`ForeignKeyViolation` handlers remain as
  race fallbacks; the FK-violation ERROR (deleted auth user) is the documented residual. **Sound.**
- **S10.** `Db.acquire()` uses `timeout=db_acquire_timeout_s` (5 s) → 503 on pool exhaustion
  (`db.py:50-51`); every handler goes through `Db`. **Sound.**
- **S11 / 0002.** `REVOKE CREATE ON SCHEMA public FROM PUBLIC` and `REVOKE TEMPORARY, CREATE ON DATABASE
  … FROM PUBLIC`, idempotent; on a fresh DB `test_db_roles::test_api_role_cannot_create_anything_anywhere`
  confirms `sixkey_api` has no CREATE/TEMP. Idempotent. See the M8 note (§5): a non-owner
  `REVOKE … FROM PUBLIC` only warns and returns success, so this must be *verified* on Supabase, not
  assumed. **Sound locally.**
- **S12.** `Settings.env` defaults to `production`. I ran the CLI matrix live: `SIXKEY_ENV` unset →
  "SIXKEY_ENV must be set…" for both the app and the daily job; `SIXKEY_ENV=production` → the app's
  startup fails ("production needs SupabaseAuthProvider… FakeAuthProvider is local only", "Application
  startup failed") and the job exits with the same message; `SIXKEY_ENV=PRODUCTION` and `SIXKEY_ENV=" dev"`
  → refused (exact match only); `SIXKEY_BIND=0.0.0.0:…` under dev → "the FakeAuthProvider (dev/test) only
  listens on a loopback address". I could not reach the fake provider under `production` by any path.
  **Sound (verified live).**
- **S13.** `redirect_slashes=False`; `/v1/vault/` etc. → the contract's 404 with no `Location`, verified
  over real HTTP with `Host: attacker.example`. **Sound.**
- **I2 (JWT).** ES256-only allow-list, `kid` must be in the JWKS, `aud` must be exactly the string
  `authenticated` (not a list), `role` must be `authenticated`, `is_anonymous` not true, exp/iat vs the
  server clock (+60 s iat skew), sub/session_id UUIDs. `alg: none` and HS256-with-the-public-key are
  refused (decode restricted to ES256 with an EC key). My X16 (remove the exact `aud` check) was killed.
  **Sound.**
- **reject-all bound.** `created_at <= minute_floor(signed Sixkey-Ts)` (`routes/enroll.py:280-281`);
  same-minute requests are included (documented residual #1). A client clock skewed +300 s signs a future
  ts, so the bound reaches ~5 min past the signature — this widens residual #1, as the design already
  notes that the client must sign with corrected time (§4.14). `minute_floor→minute_ceil` and
  `<=`→`>=`-style changes are caught (my X17, implementer F44/F45). **Sound, residual documented.**
- **Six replay residuals.** All documented in M4-NOTES §9.3 with pinning tests (`test_residual_*`), all
  in the passing suite. No cache, per the owner's decision.
- **Contract resync.** Server behaviour matches `api/openapi.yaml` rev 16 on status/code lists, headers,
  `MinuteMs`, the new rate-limit ids and rules, and the 503 sources; the independent validator agrees on
  every response in the suite and on the 4 strict counterexamples; `check_consistency` is clean.

## 5. M8 checklist corrections

Additions/strengthenings for `docs/design/notes/M4-NOTES.md §10` (the M8 list):
1. **Item 10 (hosting), strengthen for RR5 + RR2 — the launch gate.** State explicitly: **never expose
   uvicorn directly.** The reverse proxy MUST enforce (a) a request/header **read-idle timeout** (idle
   sockets that send nothing currently hold a `limit_concurrency` slot forever — RR5), (b) a **per-IP
   concurrent-connection cap**, and (c) a body read timeout well under 60 s. Size `limit_concurrency`
   above the proxy's connection cap. The 8 global large-body slots + 60 s body timeout let one identity
   deny all large writes platform-wide (RR2); consider per-source slot fairness in-app. Without the
   proxy, 256 idle TCP sockets take the service down unauthenticated.
2. **Items 6/7 (migrations/privileges), add for S11.** After `0002_least_privilege.sql`, assert the
   revokes took effect on the live project. I confirmed on the scratch cluster that a `REVOKE … FROM
   PUBLIC` run by a role that is not the object owner emits only `WARNING: no privileges could be revoked
   for "public"` and **returns success** — so on Supabase, if the migrating role does not own schema
   `public`/the database, `0002` can report success while `sixkey_api` still has CREATE/TEMP. Run
   `test_db_roles.py` against Supabase, or add a post-condition `DO` block that raises if
   `has_database_privilege('sixkey_api', current_database(), 'TEMP')` or
   `has_schema_privilege('sixkey_api','public','CREATE')` is still true.
3. **Item 10, add for RR4.** Verify the chosen proxy appends the client as the **rightmost**
   `X-Forwarded-For` value, and add a server test that a multi-value XFF from a trusted proxy keys the
   limiter on the rightmost value (guards against a leftmost/spoofable regression).
4. **New, for RR1/RR3 (before launch).** Either enforce the envelope byte budgets on `rotate`'s 422 path
   and on `init`, or correct the contract's `device_envelope_bytes`/`account_envelope_bytes`
   `applies_to`. Make a full limiter table answer `429` on the OTP-verify path too (not `otp_invalid`),
   to match the contract's own limiter rule.
5. **New, for RR6 (owner decision before launch).** The email-/IP-keyed OTP buckets let an unauthenticated
   attacker lock a specific email out of login/recovery/enrollment for ~24 h (code-kill + send-lockout).
   Decide: a CAPTCHA/Turnstile before `send`/`verify` (needs a contract change since the API proxies
   `/otp`), a verify-failure policy a third party cannot exhaust, or accept-and-document. Fold into P1/P6.

Nothing in §4 or §2 blocks M4 merge or M5. **Launch gates: RR5 (no direct uvicorn exposure + proxy
timeouts), RR6 (owner decision), RR2.**
