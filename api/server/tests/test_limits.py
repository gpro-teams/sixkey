"""Body size limits per endpoint (§5.4 N13), rate limits with the contract's default numbers (§5.5),
in-memory HMAC'd keys with a daily key (§5.6), the trusted-proxy rule, and CORS (§5.2 d6)."""

from __future__ import annotations

import dataclasses

import pytest

import sk
from sixkey_server.config import RateLimits
from sixkey_server.constants import MAX_BODY_BYTES_OTHER, MAX_BODY_BYTES_VAULT, MAX_ENVELOPE_BYTES

BODY_OPS = [
    (op["operationId"], m.upper(), p, op["x-sixkey-max-body-bytes"])
    for p, item in sk.OPENAPI["paths"].items()
    for m, op in item.items()
    if "requestBody" in op
]


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


def path_of(p):
    return p.replace("{rid}", sk.uuid4()).replace("{id}", "AAAAAAAAAAAAAAAAAAAAAA").replace("{v}", "1")


def body_of(n):
    raw = b'{"x":"' + b"a" * (n - 8) + b'"}'
    assert len(raw) == n
    return raw


def known_signer_headers(w, sc, oid):
    """Headers that pass every bodiless check (step 1) for this operation, so the body is read."""
    a = OPS_AUTH[oid]
    h = {"Content-Type": "application/json", "Sixkey-Ts": str(w.clock.now_ms()), "Sixkey-Sig": sk.b64u(b"\x01" * 64)}
    if a["account_session"] != "none":
        h["Authorization"] = f"Bearer {sc['acct'].token}"
    if a["signer"] in ("device", "device_or_enroll"):
        h["Sixkey-Device"] = sc["dev"].device_id
    elif a["signer"] == "enroll":
        h["Sixkey-Enroll"] = sc["rid"]
    elif a["signer"] == "registration":
        h["Sixkey-Device"] = sk.Dev().device_id
    return h


OPS_AUTH = {op["operationId"]: op["x-sixkey-auth"] for item in sk.OPENAPI["paths"].values() for op in item.values()}


@pytest.mark.parametrize("oid,method,path,limit", BODY_OPS, ids=[o[0] for o in BODY_OPS])
async def test_body_limit_per_endpoint(world, oid, method, path, limit):
    w = world
    assert limit == (MAX_BODY_BYTES_VAULT if oid in ("initVault", "putVault", "rotateKeys") else MAX_BODY_BYTES_OTHER)
    acct, dev, keys = await w.vault()
    flow = await w.start_approval(acct)
    sc = {"acct": await w.login(acct.email), "dev": dev, "rid": flow.rid}
    p = path.replace("{rid}", flow.rid).replace("{id}", dev.device_id).replace("{v}", "1")
    h = known_signer_headers(w, sc, oid)
    # Content-Length over the limit: refused before anything else, credentials or not
    r = await w.http.request(method, p, content=body_of(limit + 1), headers={"Content-Type": "application/json"})
    assert (r.status_code, code(r)) == (413, "too_large"), oid
    r = await w.http.request(method, p, content=body_of(limit), headers=h)
    assert r.status_code != 413, oid

    async def chunks():  # no Content-Length: the stream itself is counted
        yield b'{"x":"'
        for _ in range(limit // 65536 + 1):
            yield b"a" * 65536
        yield b'"}'

    r = await w.http.request(method, p, content=chunks(), headers=h)
    assert (r.status_code, code(r)) == (413, "too_large"), oid


BODYLESS_OPS = [
    (op["operationId"], m.upper(), p)
    for p, item in sk.OPENAPI["paths"].items()
    for m, op in item.items()
    if "requestBody" not in op
]


@pytest.mark.parametrize("oid,method,path", BODYLESS_OPS, ids=[o[0] for o in BODYLESS_OPS])
async def test_operations_without_a_body_cap_it_at_64_kib(world, oid, method, path):
    """A9: every request body is capped, on operations that define none too (64 KiB)."""
    w = world
    assert OPS_AUTH[oid] is not None
    acct, dev, keys = await w.vault()
    flow = await w.start_approval(acct)
    sc = {"acct": await w.login(acct.email), "dev": dev, "rid": flow.rid}
    p = path.replace("{rid}", flow.rid).replace("{id}", dev.device_id).replace("{v}", "1")
    r = await w.http.request(method, p, content=body_of(MAX_BODY_BYTES_OTHER + 1))
    assert (r.status_code, code(r)) == (413, "too_large"), oid
    h = known_signer_headers(w, sc, oid)
    h.pop("Content-Type")

    async def chunks():
        for _ in range(MAX_BODY_BYTES_OTHER // 65536 + 1):
            yield b"a" * 65536

    r = await w.http.request(method, p, content=chunks(), headers=h)
    assert (r.status_code, code(r)) == (413, "too_large"), oid


async def test_an_unauthenticated_body_is_not_read(world):
    """S3: without a known signer (here: no headers at all, or an unknown device) the server answers before
    reading the body, so nobody can make it buffer 9 MiB."""
    w = world
    for headers in (
        {"Content-Type": "application/json"},
        {
            "Content-Type": "application/json",
            "Sixkey-Device": sk.Dev().device_id,
            "Sixkey-Ts": str(w.clock.now_ms()),
            "Sixkey-Sig": sk.b64u(b"\x01" * 64),
        },
    ):
        sent = {"n": 0}

        async def chunks():
            for _ in range(9 * 16 - 1):
                sent["n"] += 65536
                yield b"a" * 65536

        r = await w.http.request("PUT", "/v1/vault", content=chunks(), headers=headers)
        assert r.status_code == 401 and code(r) in ("bad_signature", "unknown_device")
        assert sent["n"] <= 65536, sent["n"]  # at most the first chunk was pulled


async def test_envelope_over_8_mib_in_a_9_mib_body_is_too_large(world):
    w = world
    acct, dev, keys = await w.vault()
    env = sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, MAX_ENVELOPE_BYTES + 1)
    r = await w.api.put_vault(dev, keys, 1, env=env)
    assert (r.status_code, code(r)) == (413, "too_large")
    env = sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, MAX_ENVELOPE_BYTES)
    r = await w.api.put_vault(dev, keys, 1, env=env)
    assert r.status_code == 200
    assert await w.val("SELECT size_bytes FROM sixkey.vaults") == MAX_ENVELOPE_BYTES


async def test_device_write_and_read_limits(make_world):
    async with make_world(limits=RateLimits(otp_send_ip=(10_000, 3600), otp_verify_ip=(10_000, 3600))) as w:
        acct, dev, keys = await w.vault()
        stale = lambda: w.api.put_vault(dev, keys, 99, env=sk.envelope(keys.vault_id, keys.vk_id, 100))
        for _ in range(30):
            assert code(await stale()) == "version_conflict"
        r = await stale()
        assert code(r) == "rate_limited" and 1 <= int(r.headers["retry-after"]) <= 60
        assert r.json()["error"]["retry_after"] == int(r.headers["retry-after"])
        for _ in range(59):
            assert (await w.api.status(dev)).status_code == 200
        assert (await w.api.call("GET", "/v1/vault", dev=dev)).status_code == 200  # the 60th read
        assert code(await w.api.status(dev)) == "rate_limited"
        w.clock.advance(60_001)
        assert (await w.api.status(dev)).status_code == 200
        assert code(await stale()) == "version_conflict"


async def test_account_ceiling_spares_revocation_and_rotation(make_world):
    lim = RateLimits(
        otp_send_ip=(10_000, 3600),
        otp_verify_ip=(10_000, 3600),
        recovery_account_ip=(100, 3600),
        account_writes=(4, 60),
    )
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()
        others = [await w.recovery_device(acct, keys) for _ in range(2)]
        w.clock.advance(61_000)  # the two completes above were account writes too
        stale = lambda d: w.api.put_vault(d, keys, 99, env=sk.envelope(keys.vault_id, keys.vk_id, 100))
        results = [code(await stale(d)) for d in (dev, others[0], others[1], dev)]
        assert results == ["version_conflict"] * 4
        assert code(await stale(others[1])) == "rate_limited"  # the account's 5th write in the window
        r = await w.api.call(
            "POST", f"/v1/devices/{others[0].device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev
        )
        assert r.status_code == 200  # F8: revocation never hits the ceiling
        r = await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev)
        assert code(r) == "rate_limited"  # other pw_auth writes still do


async def test_account_session_buckets(make_world):
    """A21: session_reads (GET /v1/account, 60/60 s) and session_writes (init and enrollment requests,
    30/60 s), keyed by the account session; a 409 counts, another session has its own buckets."""
    import conftest

    lim = dataclasses.replace(
        conftest.TEST_LIMITS, session_writes=RateLimits().session_writes, session_reads=RateLimits().session_reads
    )
    assert (lim.session_writes, lim.session_reads) == ((30, 60), (60, 60))
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()
        s = await w.login(acct.email)
        for i in range(60):
            assert (await w.api.call("GET", "/v1/account", acct=s)).status_code == 200, i
        r = await w.api.call("GET", "/v1/account", acct=s)
        assert code(r) == "rate_limited" and r.headers["retry-after"]
        s2 = await w.login(acct.email)
        assert (await w.api.call("GET", "/v1/account", acct=s2)).status_code == 200
        first = await w.start_approval(acct, s2)
        for i in range(29):  # one_per_session 409s count too
            assert code(await type(first)(w, s2).create()) == "one_per_session", i
        assert code(await type(first)(w, s2).create()) == "rate_limited"
        assert code(await w.api.init(s2, sk.Dev(), sk.new_vault_keys(w.hour()))) == "rate_limited"
        w.clock.advance(60_001)
        assert code(await w.api.init(s2, sk.Dev(), sk.new_vault_keys(w.hour()))) == "vault_exists"


async def test_enrolling_devices_cannot_fill_the_owners_ceiling_but_their_own_buckets_hold(make_world):
    """§0.0r A21: an enrolling device (Sixkey-Enroll) needs only an account session, i.e. the email, so
    it never counts toward account_reads / account_writes: three enrolling sessions polling at their
    limit (180 reads, past an account ceiling of 100) leave the owner's status poll at 200. Each is still
    bounded by its own enroll:{rid} buckets (device_reads, device_writes)."""
    import conftest

    lim = dataclasses.replace(
        conftest.TEST_LIMITS,
        device_reads=(60, 60),
        device_writes=(30, 60),
        account_reads=(100, 60),
        account_writes=(4, 60),
    )
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()
        flows = [await w.start_approval(acct) for _ in range(3)]
        for f in flows:
            for i in range(60):
                assert (await f.poll()).status_code == 200, i
            r = await f.poll()
            assert code(r) == "rate_limited" and r.headers["retry-after"]  # its own enroll:{rid} bucket
        r = await w.api.status(dev)
        assert r.status_code == 200, r.text  # the owner's poll is untouched
        L = w.state.limiter
        assert L.count(L.hkey("ar", acct.sub)) == 1  # only the owner's read counted
        # writes: identical reveals by one enrolling device, past account_writes = 4 and up to its own 30
        f = flows[0]
        w.clock.advance(60_001)
        assert (await f.respond(dev, keys)).status_code == 200  # the owner's 1st account write
        for i in range(30):
            assert (await f.reveal()).status_code == 200, i
        assert code(await f.reveal()) == "rate_limited"  # enroll:{rid} device_writes
        stale = await w.api.put_vault(dev, keys, 99, env=sk.envelope(keys.vault_id, keys.vk_id, 100))
        assert code(stale) == "version_conflict"  # the owner's 2nd: not limited


async def test_enrolling_sessions_are_bounded_by_the_otp_limits_and_one_request_each(make_world):
    """What bounds the number of enrolling devices an email holder can run instead (§0.0r A21): every
    session costs an OTP send (3 per email and IP per 10 minutes, 50 per email per day), and a session
    holds at most one pending request."""
    import conftest

    lim = dataclasses.replace(conftest.TEST_LIMITS, otp_send_email_ip=RateLimits().otp_send_email_ip)
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()  # 1st send for this email from this IP
        sessions = [await w.login(acct.email) for _ in range(2)]
        r = await w.api.call("POST", "/v1/auth/otp", {"email": acct.email})
        assert code(r) == "rate_limited"  # the 4th send in 10 minutes
        f = await w.start_approval(acct, sessions[0])
        assert code(await type(f)(w, sessions[0]).create()) == "one_per_session"
        assert (await w.start_approval(acct, sessions[1])).rid


async def test_otp_send_limits(make_world):
    async with make_world(limits=RateLimits()) as w:
        email = sk.secret("limits@example.invalid")
        send = lambda e=email: w.api.call("POST", "/v1/auth/otp", {"email": e})
        for _ in range(3):
            assert (await send()).status_code == 202
        assert code(await send()) == "rate_limited"  # (email, IP) 3 per 10 minutes
        other_ip = sk.Api(sk.client(w.app, "198.51.100.40"), w.clock)
        assert (await other_ip.call("POST", "/v1/auth/otp", {"email": email})).status_code == 202
        await other_ip.http.aclose()
        for i in range(17):  # 20 per IP per hour (3 + 17)
            assert (await send(f"many{i}@example.invalid")).status_code == 202, i
        assert code(await send("one-more@example.invalid")) == "rate_limited"
        assert (await send("UPPER@example.invalid")).status_code == 429  # still the same IP


async def test_otp_email_daily_limits_across_ips(make_world):
    async with make_world(limits=RateLimits()) as w:
        email = sk.secret("daily@example.invalid")
        n = 0
        for i in range(17):
            api = sk.Api(sk.client(w.app, f"198.51.100.{i + 1}"), w.clock)
            for _ in range(3):
                r = await api.call("POST", "/v1/auth/otp", {"email": email})
                if n < 50:
                    assert r.status_code == 202, n
                else:
                    assert code(r) == "rate_limited"
                n += 1
            await api.http.aclose()
        # (email, IP) 10 per day: one IP, ten-minute steps
        email2 = sk.secret("daily2@example.invalid")
        for i in range(10):
            assert (await w.api.call("POST", "/v1/auth/otp", {"email": email2})).status_code == 202
            w.clock.advance(601_000)
        assert code(await w.api.call("POST", "/v1/auth/otp", {"email": email2})) == "rate_limited"


async def test_otp_verify_five_attempts_per_code(make_world):
    async with make_world(limits=RateLimits()) as w:
        email = sk.secret("verify@example.invalid")
        await w.api.call("POST", "/v1/auth/otp", {"email": email})
        right = w.provider.last_code(email)
        wrong = "000000" if right != "000000" else "111111"
        for _ in range(5):
            assert code(await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": wrong})) == "otp_invalid"
        r = await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": right})
        assert code(r) == "otp_invalid"  # the code is dead after five
        await w.api.call("POST", "/v1/auth/otp", {"email": email})  # a new code gets five again
        assert (
            await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": w.provider.last_code(email)})
        ).status_code == 200


async def test_otp_verify_ip_limit_and_expiry(make_world):
    async with make_world(limits=RateLimits()) as w:
        for i in range(30):
            r = await w.api.call("POST", "/v1/auth/verify", {"email": f"nobody{i}@example.invalid", "token": "123456"})
            assert code(r) == "otp_invalid"
        assert (
            code(await w.api.call("POST", "/v1/auth/verify", {"email": "x@example.invalid", "token": "123456"}))
            == "rate_limited"
        )
    async with make_world() as w:
        email = sk.secret("expiry@example.invalid")
        await w.api.call("POST", "/v1/auth/otp", {"email": email})
        w.clock.advance(3_600_001)
        r = await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": w.provider.last_code(email)})
        assert code(r) == "otp_invalid"  # expired = wrong (not distinguished)


async def test_recovery_limits(make_world):
    async with make_world(
        limits=RateLimits(
            otp_send_ip=(10_000, 3600),
            otp_verify_ip=(10_000, 3600),
            otp_send_email_ip=(100, 600),
            otp_send_email_ip_day=(100, 86_400),
        )
    ) as w:
        acct, dev, keys = await w.vault()
        bad = sk.b64(sk.rnd(32))
        for _ in range(5):
            d = sk.Dev()
            r = await w.api.call(
                "POST",
                "/v1/enroll/recovery",
                {"device_id": d.device_id, "sig_pubkey": d.spki_b64, "recovery_auth": bad},
                acct=await w.login(acct.email),
                reg=d,
            )
            assert code(r) == "recovery_mismatch"
        d = sk.Dev()
        r = await w.api.call(
            "POST",
            "/v1/enroll/recovery",
            {"device_id": d.device_id, "sig_pubkey": d.spki_b64, "recovery_auth": keys.rec_auth_b64},
            acct=await w.login(acct.email),
            reg=d,
        )
        assert code(r) == "rate_limited"  # the right code is refused too now
        api2 = sk.Api(sk.client(w.app, "198.51.100.77"), w.clock)
        r = await api2.call(
            "POST",
            "/v1/enroll/recovery",
            {"device_id": d.device_id, "sig_pubkey": d.spki_b64, "recovery_auth": keys.rec_auth_b64},
            acct=await w.login(acct.email),
            reg=d,
        )
        assert r.status_code == 200  # (account, IP): another IP may
        await api2.http.aclose()


async def test_rate_limit_keys_hold_no_ip_or_email(make_world):
    async with make_world(limits=RateLimits(), trusted_proxies=frozenset({"203.0.113.7"})) as w:
        email = sk.secret("keys@example.invalid")
        spoof = "198.51.100.23"
        r = await w.api.call("POST", "/v1/auth/otp", {"email": email}, headers={"X-Forwarded-For": spoof})
        assert r.status_code == 202
        lim = w.state.limiter
        blob = repr(lim._hits) + repr(lim._counters)
        for s in (email, spoof, "203.0.113.7", "example.invalid"):
            assert s not in blob
        old_keys = set(lim._hits)
        w.clock.advance(86_400_000)  # the next UTC day: new key, no counters
        assert lim.hkey("oi", spoof) not in old_keys and not lim._hits


async def test_forwarded_for_only_from_a_trusted_proxy(make_world):
    lim = RateLimits(otp_send_ip=(2, 3600))
    async with make_world(limits=lim, trusted_proxies=frozenset({"203.0.113.7"})) as w:
        for i in range(2):
            assert (
                await w.api.call(
                    "POST",
                    "/v1/auth/otp",
                    {"email": f"p{i}@example.invalid"},
                    headers={"X-Forwarded-For": "198.51.100.1"},
                )
            ).status_code == 202
        r = await w.api.call(
            "POST", "/v1/auth/otp", {"email": "p3@example.invalid"}, headers={"X-Forwarded-For": "198.51.100.1"}
        )
        assert code(r) == "rate_limited"
        r = await w.api.call(
            "POST", "/v1/auth/otp", {"email": "p4@example.invalid"}, headers={"X-Forwarded-For": "198.51.100.2"}
        )
        assert r.status_code == 202  # another client behind the proxy
    async with make_world(limits=lim, trusted_proxies=frozenset({"203.0.113.7"})) as w:
        # re-review RR4: the proxy appends the client, so only the rightmost value is believed; whatever
        # the client wrote to the left of it is its own invention
        for i, forged in enumerate(("192.0.2.1", "192.0.2.2")):
            r = await w.api.call(
                "POST",
                "/v1/auth/otp",
                {"email": f"m{i}@example.invalid"},
                headers={"X-Forwarded-For": f"{forged}, 198.51.100.9"},
            )
            assert r.status_code == 202
        r = await w.api.call(
            "POST",
            "/v1/auth/otp",
            {"email": "m3@example.invalid"},
            headers={"X-Forwarded-For": "192.0.2.3,198.51.100.9"},
        )
        assert code(r) == "rate_limited"  # one client, three forged lefts
        r = await w.api.call(
            "POST",
            "/v1/auth/otp",
            {"email": "m4@example.invalid"},
            headers={"X-Forwarded-For": "192.0.2.1, 198.51.100.10"},
        )
        assert r.status_code == 202  # same left, another client
    async with make_world(limits=lim, trusted_proxies=frozenset({"203.0.113.7"})) as w:
        # two X-Forwarded-For header lines: not what the proxy writes, so neither is believed (the peer counts)
        h = [("X-Forwarded-For", "198.51.100.21"), ("X-Forwarded-For", "198.51.100.22")]
        for i in range(2):
            r = await w.http.post(
                "/v1/auth/otp",
                content=sk.compact({"email": f"d{i}@example.invalid"}).encode(),
                headers=[("Content-Type", "application/json"), *h],
            )
            assert r.status_code == 202
        r = await w.api.call("POST", "/v1/auth/otp", {"email": "d9@example.invalid"})  # the proxy's own address
        assert code(r) == "rate_limited"
    async with make_world(limits=lim) as w:  # the peer is not a trusted proxy
        for i, xff in enumerate(("198.51.100.1", "198.51.100.2")):
            assert (
                await w.api.call(
                    "POST", "/v1/auth/otp", {"email": f"q{i}@example.invalid"}, headers={"X-Forwarded-For": xff}
                )
            ).status_code == 202
        r = await w.api.call(
            "POST", "/v1/auth/otp", {"email": "q9@example.invalid"}, headers={"X-Forwarded-For": "198.51.100.3"}
        )
        assert code(r) == "rate_limited"  # XFF ignored: one bucket


async def test_cors_never_decides_anything(make_world):
    ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    async with make_world(cors_origins=(ext,)) as w:
        acct, dev, keys = await w.vault()
        for origin, acao in ((ext, ext), ("https://evil.example", None), (None, None)):
            h = {"Origin": origin} if origin else {}
            r = await w.api.status(dev, headers=h)
            assert r.status_code == 200 and r.headers.get("access-control-allow-origin") == acao
            r = await w.api.status(sk.Dev(), headers=h)
            assert r.status_code == 401 and r.headers.get("access-control-allow-origin") == acao
        pre = await w.http.request(
            "OPTIONS", "/v1/vault", headers={"Origin": ext, "Access-Control-Request-Method": "PUT"}
        )
        assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == ext
        assert "sixkey-sig" in pre.headers["access-control-allow-headers"]
        pre = await w.http.request(
            "OPTIONS", "/v1/vault", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"}
        )
        assert "access-control-allow-origin" not in pre.headers
