"""Plausible server bugs. tests/mutation/run_mutants.py applies them one at a time to a scratch copy and
runs the suite; every one must make at least one test fail ("killed").

  M01-M45  the implementer's (first round)
  R01-R32  the reviewer's (docs/audit/internal-reviews/M4-REVIEW.md, review/my_mutants.py); R01, R21 and R27 re-targeted at the
           restructured pipeline, the rest verbatim
  F01-F..  one or more per review fix (second round)

An entry is (id, what, file, old, new) or (id, what, [(file, old, new), ...]); each old string must occur
exactly once (in the file as already edited by the entry's earlier replacements). Files are relative to
sixkey_server/, or to the server directory when they start with "migrations/".

When the server was first formatted with ruff (2026-10), twenty entries no longer matched the new layout: M09, M25,
M26, M31, M37, M45, R08, R10, R14, R16, R26, R32, F01, F14, F25, F28, F29, F46, F47 and F52. Each was re-anchored by
replaying its edits on the unformatted file, formatting the result and taking the changed lines: the same bug,
written against the formatted source. `run_mutants.py --check` confirms every entry applies.
"""

MINE = [
    (
        "M01",
        "CAS without the version check (only the pre-check remains)",
        "routes/vault.py",
        '"   WHERE user_id = $1 AND version = $6 AND vk_id = $7"',
        '"   WHERE user_id = $1 AND vk_id = $7 AND $6::bigint > 0"',
    ),
    (
        "M02",
        "history row written outside the vault transaction",
        "routes/vault.py",
        '    await ctx.st.pause("put_vault.before_tx")\n',
        '    await ctx.st.pause("put_vault.before_tx")\n'
        '    await ctx.pool.execute("INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes, '
        'created_at) VALUES ($1, $2, $3, $4, $5, $6)", ctx.uid, if_version + 1, env.vk_id, env.text, env.size_bytes, hour)\n',
    ),
    (
        "M03",
        "tenant filter missing on GET /v1/vault/versions/{v}",
        "routes/vault.py",
        '"SELECT version, envelope FROM sixkey.vault_versions WHERE user_id = $1 AND version = $2"',
        '"SELECT version, envelope FROM sixkey.vault_versions WHERE $1::uuid IS NOT NULL AND version = $2 '
        'ORDER BY length(envelope) DESC LIMIT 1"',
    ),
    (
        "M04",
        "tenant filter missing when locking/looking up target devices",
        "routes/common.py",
        '"WHERE device_id = ANY($1::text[]) AND user_id = $2 ORDER BY device_id FOR NO KEY UPDATE"',
        '"WHERE device_id = ANY($1::text[]) AND $2::uuid IS NOT NULL ORDER BY device_id FOR NO KEY UPDATE"',
    ),
    (
        "M05",
        "signature not verified on the enrolling-device endpoints",
        "pipeline.py",
        'if not sigauth.verify(key, _msg(ctx, "enroll:" + rid, "-", ts), sig):',
        "if False:",
    ),
    (
        "M06",
        "timestamp window off by one (>= instead of >)",
        "pipeline.py",
        "if abs(int(ts) - ctx.now) > SIG_WINDOW_S * 1000:",
        "if abs(int(ts) - ctx.now) >= SIG_WINDOW_S * 1000:",
    ),
    (
        "M07",
        "idempotent replay of PUT /v1/keys compares only kver, not the text",
        "routes/keys.py",
        '    if v["bundle"] == bun.text:\n        return 200, {"kver": v["kver"]}',
        '    if v["kver"] == bun.kver:\n        return 200, {"kver": v["kver"]}',
    ),
    (
        "M08",
        "pw_auth failure counter account-wide",
        "pipeline.py",
        '"WHERE device_id = $1 AND auth_failures < $2 RETURNING auth_failures"',
        '"WHERE user_id = (SELECT user_id FROM sixkey.devices WHERE device_id = $1) AND auth_failures < $2 '
        'RETURNING auth_failures"',
    ),
    ("M09", "client IP logged", "pipeline.py", "        code=code,\n", "        code=code or ctx.client_ip(),\n"),
    (
        "M10",
        "retention keeps the oldest 30 instead of the newest 30",
        "retention.py",
        "keep = {r[0] for r in by_v[: p.keep_versions]}",
        "keep = {r[0] for r in by_v[-p.keep_versions:]}",
    ),
    (
        "M11",
        "write proof not checked on PUT /v1/vault",
        "routes/vault.py",
        'if not wire.write_proof_ok(bytes(v["write_key"]), v["vault_id"], if_version, env.checksum, b["write_proof"]):\n'
        '        raise ApiError("write_denied")\n    cursor',
        'if False:\n        raise ApiError("write_denied")\n    cursor',
    ),
    (
        "M12",
        "kver jump bound missing",
        "wire.py",
        "return if_kver < kver <= if_kver + KVER_MAX_JUMP",
        "return if_kver < kver",
    ),
    (
        "M13",
        "409 version_conflict body built from another tenant's row",
        "routes/vault.py",
        '    if v["version"] != if_version:\n        raise version_conflict(v)',
        '    if v["version"] != if_version:\n        raise version_conflict(await ctx.pool.fetchrow('
        '"SELECT version, vk_id, kver FROM sixkey.vaults ORDER BY version DESC LIMIT 1"))',
    ),
    (
        "M14",
        "PUT transaction without the device-row lock and revoked re-check (C3)",
        "routes/vault.py",
        "me = (await lock_signer(con, ctx.uid, ctx.signer))[ctx.signer]",
        'me = {"cursor": await con.fetchval("SELECT cursor FROM sixkey.devices WHERE device_id = $1", ctx.signer)}',
    ),
    (
        "M15",
        "respond advances an expired request (P6)",
        "routes/enroll.py",
        "AND state = 'pending' AND expires_at > $5 \"",
        "AND state = 'pending' AND $5::timestamptz IS NOT NULL \"",
    ),
    (
        "M16",
        "a second approver may respond",
        "routes/enroll.py",
        "AND state = 'pending' AND expires_at > $5",
        "AND state IN ('pending', 'responded') AND expires_at > $5",
    ),
    (
        "M17",
        "approve does not check sig_pubkey_sha256",
        "routes/enroll.py",
        'if wire.sha256(bytes(row["new_sig_pubkey"])) != sp:',
        "if False:",
    ),
    (
        "M18",
        "P4 only checks password wrap vs auth",
        "wire.py",
        "if pw != auth or rec != has_recovery_verifier or pw != has_password_verifier:",
        "if pw != auth:",
    ),
    (
        "M19",
        "bundle.by not compared with the signer",
        "routes/keys.py",
        'if bun.vault_id != v["vault_id"] or bun.vk_id != v["vk_id"] or bun.by != ctx.signer:',
        'if bun.vault_id != v["vault_id"] or bun.vk_id != v["vk_id"]:',
    ),
    (
        "M20",
        "revoked answered before the signature is verified (P6), at the bodiless device lookup",
        "pipeline.py",
        '    if row is None:\n        raise ApiError("unknown_device")\n',
        '    if row is None:\n        raise ApiError("unknown_device")\n'
        '    if row["revoked_at"] is not None:\n        raise ApiError("device_revoked")\n',
    ),
    (
        "M21",
        "invalid-proof bucket missing (every flood writes the database)",
        "pipeline.py",
        'retry = self.st.limiter.hit("bp:" + dev["device_id"], lim[0], lim[1])',
        "retry = None",
    ),
    (
        "M22",
        "a valid pw_auth is not exempt from the per-device limits",
        "pipeline.py",
        "ctx.charge(device_exempt=bool(ctx.proof_valid))",
        "ctx.charge(device_exempt=False)",
    ),
    (
        "M23",
        "401/403 responses are counted against the quotas",
        "pipeline.py",
        "    if status in (401, 403):\n        ctx.refund()",
        "    if False:\n        ctx.refund()",
    ),
    (
        "M24",
        "status writes last_seen_at on every poll",
        "routes/vault.py",
        '"UPDATE sixkey.devices SET last_seen_at = $2 WHERE device_id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)"',
        '"UPDATE sixkey.devices SET last_seen_at = $2 WHERE device_id = $1"',
    ),
    (
        "M25",
        "rename does not bump devices_rev",
        "routes/devices.py",
        "        await bump_devices_rev(con, ctx.uid)\n",
        "",
    ),
    (
        "M26",
        "clone detection reports a lost-200 retry as forked",
        "routes/vault.py",
        "        return None, False  # the client did not see our last 200\n",
        "        return None, True\n",
    ),
    (
        "M27",
        "daily window one day too long",
        "retention.py",
        "oldest_day = day_floor(now_ms) - (p.keep_days - 1) * DAY_MS",
        "oldest_day = day_floor(now_ms) - p.keep_days * DAY_MS",
    ),
    (
        "M28",
        "no per-code limit on OTP verification",
        "routes/auth.py",
        "    if n > lim.otp_verify_code:\n",
        "    if False:\n",
    ),
    (
        "M29",
        "Supabase session not revoked after verify (C1)",
        "routes/auth.py",
        "    await ctx.st.provider.revoke_session(session.access_token)\n",
        "",
    ),
    (
        "M30",
        "step-up does not check iat",
        "routes/account.py",
        "if s.sub != ctx.user_id or s.iat * 1000 < ctx.now - STEP_UP_MAX_AGE_S * 1000:",
        "if s.sub != ctx.user_id:",
    ),
    (
        "M31",
        "init idempotency ignores the bundle text",
        "routes/vault.py",
        '                        and existing["bundle"] == bun.text\n',
        "",
    ),
    (
        "M32",
        "rotate does not void open enrollments",
        "routes/keys.py",
        '        await delete_enrollments(con, "user_id = $1", ctx.uid)\n',
        "",
    ),
    (
        "M33",
        "target containing '|' accepted",
        "sigauth.py",
        'if not target.startswith("/") or "|" in target or',
        'if not target.startswith("/") or',
    ),
    (
        "M34",
        "signing input uses the Host header",
        "pipeline.py",
        "return sigauth.signing_input(ctx.st.settings.host, ctx.request.method, target, signer, sub, ts, ctx.raw)",
        'return sigauth.signing_input(ctx.request.headers.get("host", ""), ctx.request.method, target, signer, sub, ts, ctx.raw)',
    ),
    (
        "M35",
        "device rows locked FOR SHARE as §5.3 writes it (deadlock between clones)",
        "routes/common.py",
        "ORDER BY device_id FOR NO KEY UPDATE",
        "ORDER BY device_id FOR SHARE",
    ),
    (
        "M36",
        "an oversized envelope is 422 instead of 413",
        "pipeline.py",
        '    if isinstance(env, str) and len(env.encode("utf-8")) > MAX_ENVELOPE_BYTES:\n        raise ApiError("too_large")',
        '    if False:\n        raise ApiError("too_large")',
    ),
    (
        "M37",
        "account session accepts any audience (both the PyJWT check and the exact-claim check, I2)",
        [
            (
                "account_session.py",
                '            audience="authenticated",\n',
                '            audience=jwt.decode(token, options={"verify_signature": False}).get("aud"),\n',
            ),
            (
                "account_session.py",
                "    if (\n"
                '        claims.get("is_anonymous") is True\n'
                '        or claims.get("role") != "authenticated"\n'
                '        or claims.get("aud") != "authenticated"\n'
                "    ):\n",
                '    if claims.get("is_anonymous") is True or claims.get("role") != "authenticated":\n',
            ),
        ],
    ),
    (
        "M38",
        "non-integer number tokens accepted",
        "schema.py",
        'def _no_float(tok: str) -> Any:\n    raise JsonError("non-integer number token")',
        "def _no_float(tok: str) -> Any:\n    return int(float(tok))",
    ),
    (
        "M39",
        "rotate locks only the signer's device row (lock order)",
        "routes/keys.py",
        "locked = await lock_devices(con, ctx.uid, all_ids + [ctx.signer])",
        "locked = {**{i: None for i in all_ids}, **await lock_devices(con, ctx.uid, [ctx.signer])}",
    ),
    (
        "M40",
        "rate-limit keys hold the raw IP / email",
        "ratelimit.py",
        'return kind + ":" + hmac.new(self._daily_key, value.encode(), hashlib.sha256).hexdigest()[:32]',
        'return kind + ":" + value',
    ),
    (
        "M41",
        "the daily key is never replaced",
        "ratelimit.py",
        "        if day != self._day:",
        "        if self._day < 0:",
    ),
    (
        "M42",
        "P4 counts a createdAt-only difference as a changed wrap",
        "wire.py",
        'return b64d(old["iv"]) != b64d(new["iv"]) or b64d(old["wrapped"]) != b64d(new["wrapped"])',
        "return old != new",
    ),
    (
        "M43",
        "enrollment expires_at kept at millisecond precision",
        "routes/enroll.py",
        "return to_dt(minute_floor(ctx.now)), to_dt(minute_ceil(ctx.now + ENROLL_TTL_S * 1000))",
        "return to_dt(minute_floor(ctx.now)), to_dt(ctx.now + ENROLL_TTL_S * 1000)",
    ),
    (
        "M44",
        "complete locks the request before the vault row (deadlocks with rotate)",
        "routes/enroll.py",
        '        await con.execute("SELECT 1 FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", uid)\n',
        "",
    ),
    (
        "M45",
        "revoke voids requests before taking the vault row (deadlocks with complete)",
        "routes/devices.py",
        "        await bump_devices_rev(con, ctx.uid)  # the vault row before enrollment rows (lock order)\n"
        '        await ctx.st.pause("revoke.between")\n'
        '        await delete_enrollments(con, "user_id = $1 AND approver_device_id = $2", ctx.uid, target)\n',
        '        await delete_enrollments(con, "user_id = $1 AND approver_device_id = $2", ctx.uid, target)\n'
        '        await ctx.st.pause("revoke.between")\n'
        "        await bump_devices_rev(con, ctx.uid)\n",
    ),
]


R01 = (
    "R01",
    "device-signed GETs also accept a bare account session (weaker credential)",
    [
        (
            "pipeline.py",
            '        if op.auth in (DEVICE, DEVICE_STEP_UP):\n            await find_device(ctx, request.headers.get("sixkey-device") or "")',
            '        if op.auth == DEVICE and op.method == "GET" and request.headers.get("sixkey-device") is None '
            'and request.headers.get("authorization"):\n'
            '            ctx.session = account_session.verify(account_session.bearer(request.headers.get("authorization")), '
            "st.provider.jwt_keys(), st.provider.issuer, ctx.now)\n"
            '            ctx.user_id, ctx.signer = ctx.session.sub, "-"\n'
            "        elif op.auth in (DEVICE, DEVICE_STEP_UP):\n"
            '            await find_device(ctx, request.headers.get("sixkey-device") or "")',
        )
    ],
)
R21 = (
    "R21",
    "a revoked device can still read (GET)",
    [
        (
            "pipeline.py",
            '        if row["revoked_at"] is not None:\n            raise ApiError("device_revoked")\n        _check_window(ctx, ts)',
            '        if row["revoked_at"] is not None and ctx.request.method != "GET":\n'
            '            raise ApiError("device_revoked")\n        _check_window(ctx, ts)',
        )
    ],
)
R27 = (
    "R27",
    "body limit only from Content-Length (a chunked body is never capped)",
    [
        (
            "pipeline.py",
            '            if n > limit:\n                raise ApiError("too_large")',
            '            if False:\n                raise ApiError("too_large")',
        )
    ],
)


# The reviewer's mutants (docs/audit/internal-reviews/M4-REVIEW.md §5), verbatim except R01, R21, R27 (re-targeted).
REVIEWER = [
    R01,
    (
        "R02",
        "tenant filter missing in DELETE /v1/vault/versions",
        [
            (
                "routes/vault.py",
                '"DELETE FROM sixkey.vault_versions WHERE user_id = $1 AND version <> $2 RETURNING 1"',
                '"DELETE FROM sixkey.vault_versions WHERE $1::uuid IS NOT NULL AND version <> $2 RETURNING 1"',
            ),
        ],
    ),
    (
        "R03",
        "tenant filter missing in GET /v1/vault/versions",
        [
            (
                "routes/vault.py",
                '"SELECT version, vk_id, size_bytes, created_at FROM sixkey.vault_versions WHERE user_id = $1 "',
                '"SELECT version, vk_id, size_bytes, created_at FROM sixkey.vault_versions WHERE $1::uuid IS NOT NULL "',
            ),
        ],
    ),
    (
        "R04",
        "PUT /v1/keys CAS on 'stored kver < new kver' (stale if_kver accepted)",
        [
            (
                "routes/keys.py",
                '    if v["kver"] != if_kver:\n        raise ApiError("keys_conflict")\n    await ctx.enforce_proof()\n    if bun.vault_id',
                '    if v["kver"] >= bun.kver:\n        raise ApiError("keys_conflict")\n    await ctx.enforce_proof()\n    if bun.vault_id',
            ),
            (
                "routes/keys.py",
                '" WHERE user_id = $1 AND kver = $2 RETURNING kver",',
                '" WHERE user_id = $1 AND kver < $3 AND $2::bigint > 0 RETURNING kver",',
            ),
        ],
    ),
    (
        "R05",
        "kver jump bound off by one (exclusive upper bound)",
        [
            (
                "wire.py",
                "return if_kver < kver <= if_kver + KVER_MAX_JUMP",
                "return if_kver < kver < if_kver + KVER_MAX_JUMP",
            ),
        ],
    ),
    (
        "R06",
        "kver jump bound off by one (one too many)",
        [
            (
                "wire.py",
                "return if_kver < kver <= if_kver + KVER_MAX_JUMP",
                "return if_kver < kver <= if_kver + KVER_MAX_JUMP + 1",
            ),
        ],
    ),
    (
        "R07",
        "idempotent comparison ignores the tail of the text (the mac)",
        [
            (
                "routes/keys.py",
                '    if v["bundle"] == bun.text:\n        return 200, {"kver": v["kver"]}\n    if v["kver"] != if_kver:',
                '    if v["bundle"][:-60] == bun.text[:-60]:\n        return 200, {"kver": v["kver"]}\n    if v["kver"] != if_kver:',
            ),
        ],
    ),
    (
        "R08",
        "a valid proof on one device clears every device's failure counter",
        [
            ("pipeline.py", '            if dev["auth_failures"] > 0:\n', "            if True:\n"),
            (
                "pipeline.py",
                '                        "UPDATE sixkey.devices SET auth_failures = 0 WHERE device_id = $1 AND auth_failures > 0 "\n'
                '                        "RETURNING 1",\n'
                '                        dev["device_id"],\n',
                '                        "UPDATE sixkey.devices SET auth_failures = 0 WHERE user_id = $1 AND auth_failures > 0 "\n'
                '                        "RETURNING 1",\n'
                "                        self._uid(),\n",
            ),
        ],
    ),
    (
        "R09",
        "byte cap may drop the head",
        [
            (
                "retention.py",
                "[v for v in oldest_first if v in daily_last and v != head]",
                "[v for v in oldest_first if v in daily_last]",
            ),
        ],
    ),
    (
        "R10",
        "clear-history without the device lock / vault FOR UPDATE (races a PUT, revoked not re-checked)",
        [
            (
                "routes/vault.py",
                "        await lock_signer(con, ctx.uid, ctx.signer)\n"
                "        head = await con.fetchrow(\n"
                '            "SELECT version, size_bytes FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", ctx.uid\n'
                "        )\n",
                '        head = await con.fetchrow("SELECT version, size_bytes FROM sixkey.vaults WHERE user_id = $1", ctx.uid)\n',
            ),
        ],
    ),
    (
        "R11",
        "PUT /v1/keys without the in-transaction device lock / revoked re-check (C3)",
        [
            (
                "routes/keys.py",
                "    async with ctx.pool.acquire() as con, con.transaction():\n        await lock_signer(con, ctx.uid, ctx.signer)\n        kver = await con.fetchval(",
                "    async with ctx.pool.acquire() as con, con.transaction():\n        kver = await con.fetchval(",
            ),
        ],
    ),
    (
        "R12",
        "every 4xx except 429 is refunded (409/422 floods uncounted)",
        [
            (
                "pipeline.py",
                "    if status in (401, 403):\n        ctx.refund()",
                "    if 400 <= status < 500 and status != 429:\n        ctx.refund()",
            ),
        ],
    ),
    (
        "R13",
        "timestamp window one-sided (any past ts accepted)",
        [
            (
                "pipeline.py",
                "if abs(int(ts) - ctx.now) > SIG_WINDOW_S * 1000:",
                "if int(ts) - ctx.now > SIG_WINDOW_S * 1000:",
            ),
        ],
    ),
    (
        "R14",
        "JWT alg none accepted (signature skipped) in the session path",
        [
            (
                "account_session.py",
                '    if header.get("alg") != "ES256" or header.get("kid") not in keys:\n',
                '    if header.get("alg") not in ("ES256", "none") or (header.get("alg") == "ES256" and header.get("kid") not in keys):\n',
            ),
            (
                "account_session.py",
                '            keys[header["kid"]],\n            algorithms=["ES256"],\n',
                '            keys.get(header.get("kid")),\n            algorithms=["ES256", "none"],\n',
            ),
            (
                "account_session.py",
                '                "require": ["exp", "iat", "sub", "aud", "iss"],\n'
                '                "verify_exp": False,\n',
                '                "require": ["exp", "iat", "sub", "aud", "iss"],\n'
                '                "verify_signature": header.get("alg") != "none",\n'
                '                "verify_exp": False,\n',
            ),
        ],
    ),
    (
        "R15",
        "CORS reflects any Origin",
        [
            ("main.py", "allowed = origin in self.origins", "allowed = bool(origin)"),
        ],
    ),
    (
        "R16",
        "log line carries a header value (User-Agent)",
        [
            ("pipeline.py", "        code=code,\n", '        code=code or request.headers.get("user-agent"),\n'),
        ],
    ),
    (
        "R17",
        "any device of the account may approve (not only the responder)",
        [
            (
                "routes/enroll.py",
                '        if row["state"] != "revealed" or row["approver_device_id"] != ctx.signer:',
                '        if row["state"] != "revealed":',
            ),
            (
                "routes/enroll.py",
                "\"WHERE request_id = $1 AND user_id = $2 AND state = 'revealed' AND approver_device_id = $3 \"",
                "\"WHERE request_id = $1 AND user_id = $2 AND state = 'revealed' AND $3::text IS NOT NULL \"",
            ),
        ],
    ),
    (
        "R18",
        "complete ignores expiry",
        [
            (
                "routes/enroll.py",
                "\"DELETE FROM sixkey.enrollments WHERE request_id = $1 AND state = 'approved' AND expires_at > $2 \"",
                "\"DELETE FROM sixkey.enrollments WHERE request_id = $1 AND state = 'approved' AND $2::timestamptz IS NOT NULL \"",
            ),
        ],
    ),
    (
        "R19",
        "reveal can be re-done with other values (SAS re-roll)",
        [
            (
                "routes/enroll.py",
                "\"WHERE request_id = $1 AND via = 'approval' AND state = 'responded' AND expires_at > $5 RETURNING 1\",",
                "\"WHERE request_id = $1 AND via = 'approval' AND state IN ('responded', 'revealed') AND expires_at > $5 RETURNING 1\",",
            ),
        ],
    ),
    (
        "R20",
        "device cap off by one in complete",
        [
            (
                "routes/enroll.py",
                "        if n >= ctx.st.settings.devices_max_active:",
                "        if n > ctx.st.settings.devices_max_active:",
            ),
        ],
    ),
    R21,
    (
        "R22",
        "X-Forwarded-For believed from any peer",
        [
            (
                "pipeline.py",
                "        if ip in self.st.settings.trusted_proxies:",
                '        if ip in self.st.settings.trusted_proxies or self.request.headers.get("x-forwarded-for"):',
            ),
        ],
    ),
    (
        "R23",
        "recovery (account, IP) bucket refunded on 403 (unlimited code guessing per IP)",
        [
            (
                "routes/enroll.py",
                "lim.recovery_account_ip, refundable=False)",
                "lim.recovery_account_ip, refundable=True)",
            ),
            (
                "routes/enroll.py",
                "lim.recovery_account_day, refundable=False)",
                "lim.recovery_account_day, refundable=True)",
            ),
        ],
    ),
    (
        "R24",
        "rotate CAS without kver (lost update vs a concurrent PUT /v1/keys)",
        [
            (
                "routes/keys.py",
                '"   WHERE user_id = $1 AND version = $2 AND kver = $3"',
                '"   WHERE user_id = $1 AND version = $2 AND $3::bigint > 0"',
            ),
        ],
    ),
    (
        "R25",
        "fork verifies Sixkey-New-Sig with the OLD key (no proof of possession of the new key)",
        [
            (
                "routes/devices.py",
                "if not sigauth.verify(new_key, _msg(",
                'if not sigauth.verify(wire.spki_public_key(bytes(ctx.device["sig_pubkey"])), _msg(',
            ),
        ],
    ),
    (
        "R26",
        "rotate does not compare bundle.by with the signer",
        [
            (
                "routes/keys.py",
                '    if env.vault_id != v["vault_id"] or bun.vault_id != v["vault_id"] or bun.vk_id != env.vk_id or bun.by != ctx.signer:\n',
                '    if env.vault_id != v["vault_id"] or bun.vault_id != v["vault_id"] or bun.vk_id != env.vk_id:\n',
            ),
        ],
    ),
    R27,
    (
        "R28",
        "PUT history rows stored at millisecond precision",
        [
            (
                "routes/vault.py",
                '    hour = hour_dt(ctx.now)\n    await ctx.st.pause("put_vault.before_tx")',
                '    hour = to_dt(ctx.now)\n    await ctx.st.pause("put_vault.before_tx")',
            ),
        ],
    ),
    (
        "R29",
        "enrolling signer not bound to the path rid",
        [
            (
                "pipeline.py",
                'if not sigauth.RID_RE.match(rid) or rid != ctx.path_params.get("rid"):',
                "if not sigauth.RID_RE.match(rid):",
            ),
        ],
    ),
    (
        "R30",
        "fork device cap off by one",
        [
            (
                "routes/devices.py",
                "            if n >= ctx.st.settings.devices_max_active:",
                "            if n > ctx.st.settings.devices_max_active:",
            ),
        ],
    ),
    (
        "R31",
        "write proof checked against if_version - 1 tolerance (stale proof replay)",
        [
            (
                "wire.py",
                "    return hmac.compare_digest(expected, got)",
                '    alt = hmac.new(bytes(write_key), f"{WRITE_PROOF_PREFIX}{vault_id}|{if_version - 1}|{checksum_b64}".encode(), hashlib.sha256).digest()\n    return hmac.compare_digest(expected, got) or hmac.compare_digest(alt, got)',
            ),
        ],
    ),
    (
        "R32",
        "pw failure counter not capped (unbounded WAL writes)",
        [
            ("pipeline.py", "                AUTH_FAILURES_CAP,\n", "                AUTH_FAILURES_CAP + 1000,\n"),
        ],
    ),
]

# One or more per fix of the second round (docs/design/notes/M4-NOTES.md, "Review fixes").
FIXES = [
    # S1
    (
        "F01",
        "S1: OTP attempt counted only after the provider answered (check-then-act)",
        [
            (
                "routes/auth.py",
                '    n = L.incr(L.hkey("ov", email))\n'
                "    if n is None:\n"
                '        raise ApiError("rate_limited", retry_after=60)  # the counter table is full (contract limiter rule)\n'
                "    if n > lim.otp_verify_code:\n"
                '        raise ApiError("otp_invalid")\n'
                "    session = await ctx.st.provider.verify_otp(email, token)\n"
                "    if session is None:\n",
                '    if L.get(L.hkey("ov", email)) >= lim.otp_verify_code:\n'
                '        raise ApiError("otp_invalid")\n'
                "    session = await ctx.st.provider.verify_otp(email, token)\n"
                "    if session is None:\n"
                '        L.incr(L.hkey("ov", email))\n',
            ),
        ],
    ),
    (
        "F02",
        "S1/A22: a new code does not reset the email's attempts",
        [("routes/auth.py", '    L.reset(L.hkey("ov", email))  # a new code gets its own 5 attempts\n', "")],
    ),
    # S13
    (
        "F03",
        "S13: trailing-slash redirect built from the Host header",
        [("main.py", "lifespan=lifespan, redirect_slashes=False)", "lifespan=lifespan, redirect_slashes=True)")],
    ),
    # S2 / S4
    (
        "F04",
        "S2: no per-account bucket for valid-proof requests",
        [
            (
                "pipeline.py",
                '                self._hit(L.hkey("pv", self.user_id or ""), lim.proof_valid_account)',
                "                pass",
            )
        ],
    ),
    (
        "F05",
        "S4: no per-device envelope byte budget",
        [
            (
                "pipeline.py",
                '                    self._hit("eb:" + who, lim.device_envelope_bytes, refundable=False, amount=n)',
                "                    pass",
            )
        ],
    ),
    (
        "F06",
        "S4: the device byte budget is refunded on 403 (write_denied floods are free again)",
        [
            (
                "pipeline.py",
                "lim.device_envelope_bytes, refundable=False, amount=n)",
                "lim.device_envelope_bytes, refundable=True, amount=n)",
            )
        ],
    ),
    (
        "F07",
        "S2/S4: a valid-proof rotate pays the device byte budget (a clone crowds out the owner's rotation)",
        [
            (
                "pipeline.py",
                "                if not device_exempt:  # paid even when it then fails",
                "                if True:  # paid even when it then fails",
            )
        ],
    ),
    (
        "F08",
        "S2: no per-account envelope byte budget",
        [
            (
                "pipeline.py",
                '                self._hit(L.hkey("ab", self.user_id or ""), lim.account_envelope_bytes, amount=n)',
                "                pass",
            )
        ],
    ),
    (
        "F09",
        "S2: the account byte budget is not refunded on 403 (a clone exhausts the owner's budget)",
        [
            (
                "pipeline.py",
                "lim.account_envelope_bytes, amount=n)",
                "lim.account_envelope_bytes, refundable=False, amount=n)",
            )
        ],
    ),
    # S3
    (
        "F10",
        "S3: the body is read before the session and signer checks",
        [
            (
                "pipeline.py",
                "        limit = precheck(request, op)\n",
                "        limit = precheck(request, op)\n        ctx.raw = await read_body(request, limit, st.settings.body_timeout_s)\n",
            ),
            (
                "pipeline.py",
                "        ctx.raw = await read_body(request, limit, st.settings.body_timeout_s)\n        if ctx._pending",
                "        if ctx._pending",
            ),
        ],
    ),
    (
        "F11",
        "S3: 9 MiB bodies without a bounded number of slots",
        [("pipeline.py", "            await take_large_slot(st)\n            slot = True", "            pass")],
    ),
    (
        "F12",
        "S3: a large-body slot is never given back",
        [
            (
                "pipeline.py",
                "        if slot:\n            st.large_slots.release()",
                "        if False:\n            st.large_slots.release()",
            )
        ],
    ),
    (
        "F13",
        "S3: no body read timeout (slow bodies hold memory forever)",
        [("pipeline.py", "return await asyncio.wait_for(read(), timeout_s)", "return await read()")],
    ),
    (
        "F14",
        "S3: uvicorn without limit_concurrency",
        [
            ("__main__.py", '        limit_concurrency=int(os.environ.get("SIXKEY_LIMIT_CONCURRENCY", "256")),\n', ""),
        ],
    ),
    (
        "F15",
        "A9: operations without a body are not capped at 64 KiB",
        [("pipeline.py", "    limit = op.max_body or MAX_BODY_BYTES_OTHER\n", "    limit = op.max_body or 1 << 30\n")],
    ),
    # S5
    (
        "F16",
        "S5: IPv6 keyed per /128",
        [("pipeline.py", 'return str(ipaddress.ip_network(f"{a}/64", strict=False))', "return str(a)")],
    ),
    (
        "F17",
        "S5: IPv4-mapped IPv6 counted apart from the IPv4 address",
        [
            (
                "pipeline.py",
                "        if a.ipv4_mapped is not None:\n            return str(a.ipv4_mapped)",
                "        if False:\n            return str(a.ipv4_mapped)",
            )
        ],
    ),
    (
        "F18",
        "S5: gc does not prune windows (IP-keyed timestamps kept past 1 h)",
        [
            (
                "ratelimit.py",
                "            w.prune(now)\n            if not w.entries:\n                del self._hits[k]",
                "            if not w.entries:\n                del self._hits[k]",
            )
        ],
    ),
    (
        "F19",
        "S5: the window table grows without a cap",
        [
            (
                "ratelimit.py",
                "        if w is None:\n            if len(self._hits) >= self.max_keys:",
                "        if w is None:\n            if False:",
            )
        ],
    ),
    (
        "F20",
        "S5: the counter table grows without a cap",
        [("ratelimit.py", "if n == 0 and len(self._counters) >= self.max_keys:", "if False:")],
    ),
    (
        "F21",
        "S5: expired counters are never collected",
        [
            (
                "ratelimit.py",
                "for k in [k for k, (_, t) in self._counters.items() if now - t >= COUNTER_TTL_MS]:",
                "for k in []:",
            )
        ],
    ),
    # S6
    (
        "F22",
        "S6: Content-Type not checked (cross-site simple requests)",
        [("pipeline.py", "if op.max_body is not None and not json_content_type(request):", "if False:")],
    ),
    (
        "F23",
        "S6: any charset accepted",
        [
            (
                "pipeline.py",
                'return len(parts) == 1 or parts[1].strip().lower() == "charset=utf-8"',
                'return len(parts) == 1 or parts[1].strip().lower().startswith("charset=")',
            )
        ],
    ),
    (
        "F24",
        "S6: Content-Type matched by prefix (application/jsonx)",
        [
            (
                "pipeline.py",
                'if parts[0].strip().lower() != "application/json" or len(parts) > 2:',
                'if not parts[0].strip().lower().startswith("application/json") or len(parts) > 2:',
            )
        ],
    ),
    # S7
    (
        "F25",
        "S7: a deadlock in a handler is 500 instead of 503",
        [
            (
                "db.py",
                "    asyncpg.exceptions.DeadlockDetectedError,  # e.g. account deletion's cascade racing a write (A1, S7)\n",
                "",
            ),
        ],
    ),
    (
        "F26",
        "S7: the provider's deletion deadlock is not mapped to unavailable",
        [
            (
                "auth_provider.py",
                "        except (asyncpg.exceptions.DeadlockDetectedError, asyncpg.exceptions.SerializationError):\n"
                "            raise ProviderUnavailable() from None",
                "        except ZeroDivisionError:\n            raise ProviderUnavailable() from None",
            )
        ],
    ),
    (
        "F27",
        "S7: the deletion is not retried",
        [
            (
                "routes/account.py",
                "            if attempt == 2:\n                raise\n            await asyncio.sleep(0.05)",
                "            raise",
            )
        ],
    ),
    # S8
    (
        "F28",
        "S8: enrollment create decides one_per_session from a unique violation (ERROR in the PG log)",
        [
            (
                "routes/enroll.py",
                "                \"state, created_at, expires_at) VALUES ($1, 'approval', $2, $3, $4, $5, 'pending', $6, $7) \"\n"
                '                "ON CONFLICT (user_id, session_ref) DO NOTHING RETURNING request_id",\n'
                "                uid,\n",
                "                \"state, created_at, expires_at) VALUES ($1, 'approval', $2, $3, $4, $5, 'pending', $6, $7) \"\n"
                '                "RETURNING request_id",\n'
                "                uid,\n",
            ),
        ],
    ),
    (
        "F29",
        "S8: recovery decides one_per_session from a unique violation",
        [
            (
                "routes/enroll.py",
                '                    "ON CONFLICT (user_id, session_ref) DO NOTHING RETURNING request_id",\n',
                '                    "RETURNING request_id",\n',
            ),
        ],
    ),
    (
        "F30",
        "S8: concurrent init decided from a unique violation on the vault row",
        [("routes/vault.py", '" ON CONFLICT (user_id) DO NOTHING RETURNING 1",', '" RETURNING 1",')],
    ),
    (
        "F31",
        "S8: init's device insert decided from a unique violation",
        [
            (
                "routes/vault.py",
                "\"VALUES ($1, $2, $3, $4, 'first', $5) ON CONFLICT (device_id) DO NOTHING RETURNING 1\",",
                "\"VALUES ($1, $2, $3, $4, 'first', $5) RETURNING 1\",",
            )
        ],
    ),
    (
        "F32",
        "S8: complete's device insert without ON CONFLICT (a taken id is a 500)",
        [
            (
                "routes/enroll.py",
                '"created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (device_id) DO NOTHING RETURNING 1",',
                '"created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING 1",',
            )
        ],
    ),
    (
        "F33",
        "S8: fork's device insert decided from a unique violation",
        [
            (
                "routes/devices.py",
                "\"created_at) VALUES ($1, $2, $3, $4, 'fork', $5, $6) ON CONFLICT (device_id) DO NOTHING RETURNING 1\",",
                "\"created_at) VALUES ($1, $2, $3, $4, 'fork', $5, $6) RETURNING 1\",",
            )
        ],
    ),
    (
        "F34",
        "S8: a concurrent init is answered vault_exists without deciding again (idempotent retry lost)",
        [
            (
                "routes/vault.py",
                '        except _Retry:\n            if attempt == 2:\n                raise ApiError("vault_exists") from None',
                '        except _Retry:\n            raise ApiError("vault_exists") from None',
            )
        ],
    ),
    # S10
    (
        "F35",
        "S10: the pool acquire has no timeout (requests queue forever)",
        [("db.py", "return self._pool.acquire(timeout=self._timeout)", "return self._pool.acquire()")],
    ),
    # S11
    (
        "F36",
        "S11: CREATE on schema public left to PUBLIC",
        [("migrations/0002_least_privilege.sql", "REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n", "")],
    ),
    (
        "F37",
        "S11: TEMPORARY on the database left to PUBLIC",
        [
            (
                "migrations/0002_least_privilege.sql",
                "  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());\n",
                "",
            )
        ],
    ),
    # S12 / P3
    ("F38", "S12: Settings default to dev", [("config.py", 'env: str = "production"', 'env: str = "dev"')]),
    (
        "F39",
        "S12: SIXKEY_ENV unset means dev",
        [("config.py", '        env = e.get("SIXKEY_ENV")\n', '        env = e.get("SIXKEY_ENV", "dev")\n')],
    ),
    (
        "F40",
        "S12: the app runs the FakeAuthProvider in production",
        [
            (
                "main.py",
                '        if settings.env not in ("dev", "test"):\n            raise SystemExit("production needs',
                '        if False:\n            raise SystemExit("production needs',
            )
        ],
    ),
    (
        "F41",
        "S12: dev/test listens on a public address",
        [("__main__.py", 'if settings.env != "production" and host not in LOOPBACK:', "if False:")],
    ),
    (
        "F42",
        "S12: the daily job runs the FakeAuthProvider in production",
        [
            (
                "jobs.py",
                '    if s.env not in ("dev", "test"):\n        raise SystemExit',
                "    if False:\n        raise SystemExit",
            )
        ],
    ),
    (
        "F43",
        "P3: no warning when production has no trusted proxy",
        [("__main__.py", '        applog.emit(event="warning_no_trusted_proxy")', "        pass")],
    ),
    # A2 replay mitigation
    (
        "F44",
        "A2: reject-all deletes every open request (no signed-time bound)",
        [
            (
                "routes/enroll.py",
                '"user_id = $1 AND created_at <= $2", ctx.uid,',
                '"user_id = $1 AND $2::timestamptz IS NOT NULL", ctx.uid,',
            )
        ],
    ),
    (
        "F45",
        "A2: reject-all bounded by the server's clock instead of the signed Sixkey-Ts",
        [("routes/enroll.py", "to_dt(minute_floor(ctx.ts)))", "to_dt(minute_floor(ctx.now)))")],
    ),
    # I2 / T1
    (
        "F46",
        "I2: an audience list containing authenticated is accepted",
        [
            (
                "account_session.py",
                "    if (\n"
                '        claims.get("is_anonymous") is True\n'
                '        or claims.get("role") != "authenticated"\n'
                '        or claims.get("aud") != "authenticated"\n'
                "    ):\n",
                '    if claims.get("is_anonymous") is True or claims.get("role") != "authenticated":\n',
            ),
        ],
    ),
    (
        "F47",
        "I2: a token without role authenticated is accepted",
        [
            (
                "account_session.py",
                "    if (\n"
                '        claims.get("is_anonymous") is True\n'
                '        or claims.get("role") != "authenticated"\n'
                '        or claims.get("aud") != "authenticated"\n'
                "    ):\n",
                '    if claims.get("is_anonymous") is True or claims.get("aud") != "authenticated":\n',
            ),
        ],
    ),
    (
        "F48",
        "T1: every device-signed operation also accepts a bare account session",
        [
            (
                "pipeline.py",
                '        if op.auth in (DEVICE, DEVICE_STEP_UP):\n            await find_device(ctx, request.headers.get("sixkey-device") or "")',
                '        if op.auth == DEVICE and request.headers.get("sixkey-device") is None '
                'and request.headers.get("authorization"):\n'
                '            ctx.session = account_session.verify(account_session.bearer(request.headers.get("authorization")), '
                "st.provider.jwt_keys(), st.provider.issuer, ctx.now)\n"
                '            ctx.user_id, ctx.signer = ctx.session.sub, "-"\n'
                "        elif op.auth in (DEVICE, DEVICE_STEP_UP):\n"
                '            await find_device(ctx, request.headers.get("sixkey-device") or "")',
            )
        ],
    ),
    # A21 buckets (contract revision 15)
    (
        "F52",
        "A21: no per-session buckets for account-session endpoints",
        [
            (
                "pipeline.py",
                "        elif self.session is not None:\n"
                "            self._hit(\n"
                '                L.hkey("sw" if write else "sr", self.session.session_id),\n',
                "        elif self.session is not None:\n"
                "            (lambda *a: None)(\n"
                '                L.hkey("sw" if write else "sr", self.session.session_id),\n',
            ),
        ],
    ),
    (
        "F53",
        "A21 (rev 18): an enrolling device counts toward the account ceiling again",
        [
            (
                "pipeline.py",
                "            if not self.op.account_ceiling_exempt and self.device is not None:\n",
                "            if not self.op.account_ceiling_exempt:\n",
            )
        ],
    ),
    (
        "F54",
        "A21: an enrolling device shares one bucket for every request of the account",
        [
            (
                "pipeline.py",
                'else "enroll:" + str(self.enrollment["request_id"])',
                'else "enroll:" + str(self.enrollment["user_id"])',
            )
        ],
    ),
    # A18 strict request JSON
    (
        "F49",
        "A18: duplicate keys accepted in request bodies and nested texts",
        [
            (
                "schema.py",
                '        if k in out:\n            raise JsonError("duplicate key")',
                "        if False:\n            pass",
            )
        ],
    ),
    (
        "F50",
        "A18: NUL accepted in strings",
        [
            (
                "schema.py",
                '            if "\\x00" in x:\n                raise JsonError("NUL in a string")',
                "            if False:\n                pass",
            )
        ],
    ),
    (
        "F51",
        "A18: lone surrogates accepted in strings",
        [
            (
                "schema.py",
                '                x.encode("utf-8")\n            except UnicodeEncodeError:\n'
                '                raise JsonError("lone surrogate") from None',
                '                pass\n            except UnicodeEncodeError:\n                raise JsonError("lone surrogate") from None',
            )
        ],
    ),
]

# Third round: the re-review of the fix pass (docs/audit/internal-reviews/M4-REREVIEW.md).
RECHECK = [
    (
        "F55",
        "RR4: X-Forwarded-For believed by its leftmost (client-written) value",
        [("pipeline.py", 'ip = values[0].split(",")[-1].strip()', 'ip = values[0].split(",")[0].strip()')],
    ),
    (
        "F56",
        "charset: the old leniency (utf8 alias, quoted value) accepted again",
        [
            (
                "pipeline.py",
                'return len(parts) == 1 or parts[1].strip().lower() == "charset=utf-8"',
                'return len(parts) == 1 or parts[1].strip().lower().replace(\'"\', "") in ("charset=utf-8", "charset=utf8")',
            )
        ],
    ),
    (
        "F57",
        "Content-Type: parameters after charset=utf-8 accepted",
        [
            (
                "pipeline.py",
                'if parts[0].strip().lower() != "application/json" or len(parts) > 2:',
                'if parts[0].strip().lower() != "application/json":',
            )
        ],
    ),
    (
        "F58",
        "RR1: a body that does not parse (rotate 422/413) pays no bucket",
        [
            (
                "pipeline.py",
                "            except ApiError:\n"
                "                # a body that does not parse carries no valid proof: it pays every bucket, the byte\n"
                "                # budgets included, before its 413/422 (re-review RR1)\n"
                "                ctx.charge()\n                raise",
                "            except ApiError:\n                raise",
            )
        ],
    ),
    (
        "F59",
        "RR1: init pays no byte budget",
        [
            (
                "pipeline.py",
                '                self._hit(L.hkey("sb", self.session.session_id), lim.session_envelope_bytes, amount=len(self.raw))',
                "                pass",
            )
        ],
    ),
    (
        "F60",
        "RR1: init charged to the account's budget (the email holder can starve the owner's writes)",
        [
            (
                "pipeline.py",
                'self._hit(L.hkey("sb", self.session.session_id), lim.session_envelope_bytes, amount=len(self.raw))',
                'self._hit(L.hkey("ab", str(uuid.UUID(self.session.sub))), lim.account_envelope_bytes, amount=len(self.raw))',
            )
        ],
    ),
    (
        "F61",
        "RR3: a full counter table is answered otp_invalid instead of 429",
        [
            (
                "routes/auth.py",
                '    if n is None:\n        raise ApiError("rate_limited", retry_after=60)',
                '    if n is None:\n        raise ApiError("otp_invalid")',
            )
        ],
    ),
    (
        "F63",
        "A21 (rev 18): no per-rid limit for enrolling devices",
        [
            (
                "pipeline.py",
                '            if not device_exempt:\n                self._hit(("dw:" if write else "dr:") + who,',
                '            if not device_exempt and self.device is not None:\n                self._hit(("dw:" if write else "dr:") + who,',
            )
        ],
    ),
    (
        "F62",
        "0002 post-condition only warns (a no-op revoke goes unnoticed on Supabase)",
        [
            (
                "migrations/0002_least_privilege.sql",
                "    RAISE EXCEPTION 'sixkey_api still has",
                "    RAISE NOTICE 'sixkey_api still has",
            )
        ],
    ),
]

MUTANTS = MINE + REVIEWER + FIXES + RECHECK
