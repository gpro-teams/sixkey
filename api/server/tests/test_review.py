"""Regressions for docs/audit/internal-reviews/M4-REVIEW.md (S1-S14, T1-T3, I2) and the replay residuals (A2).

The reviewer's probes (review/test_review_probes.py) asserted what the server did; these assert what it
must do now. The replay tests at the end assert the documented residuals, so docs/design/notes/M4-NOTES.md A2 stays true.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import uuid

import pytest

import pgutil
import sk
from conftest import HOUR, T0
from sixkey_server.auth_provider import ProviderUnavailable
from sixkey_server.config import RateLimits, Settings
from sixkey_server.ratelimit import COUNTER_TTL_MS, Limiter
from sixkey_server.retention import Policy, select_kept

OPS = {op["operationId"]: (m.upper(), p, op) for p, item in sk.OPENAPI["paths"].items() for m, op in item.items()}


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


@pytest.fixture
def allow_5xx():
    """For the tests that provoke 503 unavailable on purpose (contract: applies to any operation)."""
    sk.ALLOW_5XX["value"] = True
    yield
    sk.ALLOW_5XX["value"] = False


def held(w, name):
    """A pause hook: the first request reaching `name` waits until release is set."""
    first, release = asyncio.Event(), asyncio.Event()

    async def hold():
        if not first.is_set():
            first.set()
            await release.wait()

    w.state.hooks[name] = hold
    return first, release


async def scene(w):
    acct, dev, keys = await w.vault()
    flow = await w.start_approval(acct)
    return acct, dev, keys, flow


def path_of(oid, dev, flow):
    return OPS[oid][1].replace("{id}", dev.device_id).replace("{rid}", flow.rid).replace("{v}", "1")


# ------------------------------------------------------------------------------------ T1: weaker credentials


@pytest.mark.parametrize(
    "oid",
    [o for o, (_, _, op) in OPS.items() if op["x-sixkey-auth"]["signer"] in ("device", "enroll", "device_or_enroll")],
)
async def test_a_bare_account_session_never_replaces_a_signature(world, oid):
    w = world
    acct, dev, keys, flow = await scene(w)
    method, _, op = OPS[oid]
    s = await w.login(acct.email)
    h = {"Authorization": f"Bearer {s.token}", "Content-Type": "application/json"}
    r = await w.http.request(method, path_of(oid, dev, flow), content=b"{}" if "requestBody" in op else b"", headers=h)
    assert (r.status_code, code(r)) == (401, "bad_signature"), oid


@pytest.mark.parametrize(
    "oid", [o for o, (_, _, op) in OPS.items() if op["x-sixkey-auth"]["account_session"] != "none"]
)
async def test_a_device_signature_never_replaces_the_account_session(world, oid):
    w = world
    acct, dev, keys, flow = await scene(w)
    method, _, op = OPS[oid]
    body = {"password_auth": keys.pw_auth_b64} if "requestBody" in op else None
    r = await w.api.call(method, path_of(oid, dev, flow), body, dev=dev)  # signed, no Authorization
    assert (r.status_code, code(r)) == (401, "session_invalid"), oid


# ------------------------------------------------------------------------------------ S1: OTP attempts


async def test_otp_attempts_are_reserved_before_the_provider_is_awaited(world):
    w = world
    email = sk.secret("race@example.invalid")
    assert (await w.api.call("POST", "/v1/auth/otp", {"email": email})).status_code == 202
    right = w.provider.last_code(email)
    real, reached = w.provider.verify_otp, {"n": 0}

    async def slow_verify(e, t):  # an HTTP round trip to Supabase
        await asyncio.sleep(0.05)
        reached["n"] += 1
        return await real(e, t)

    w.provider.verify_otp = slow_verify
    guesses = [f"{i:06d}" for i in range(41) if f"{i:06d}" != right][:40]
    rs = await asyncio.gather(*(w.api.call("POST", "/v1/auth/verify", {"email": email, "token": g}) for g in guesses))
    assert all(code(r) == "otp_invalid" for r in rs)
    assert reached["n"] == 5  # the limit, not 40
    r = await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": right})
    assert code(r) == "otp_invalid" and reached["n"] == 5  # the code is dead; the provider is not even asked


# ------------------------------------------------------------------------------------ S13: trailing slash


@pytest.mark.parametrize(
    "path", ["/v1/vault/", "/v1/sync/status/", "/healthz/", "/v1/devices/AAAAAAAAAAAAAAAAAAAAAA/revoke/"]
)
async def test_trailing_slash_is_404_not_a_host_built_redirect(world, path):
    r = await world.http.request("POST" if "revoke" in path else "GET", path, headers={"Host": "attacker.example"})
    assert r.status_code == 404 and r.json()["error"] == {"code": "not_found"} and "location" not in r.headers


# ------------------------------------------------------------------------------------ S2 / S4: limits


async def test_valid_proof_requests_are_bounded_per_account(world):
    """S2: revoke and rotate with a valid proof skip the per-device limits and the account ceiling, but
    not their own per-account bucket (60/min). Invalid proofs never reach it (their own bucket)."""
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    for _ in range(40):  # a clone's wrong proofs: not this bucket
        await w.api.call(
            "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": sk.b64(sk.rnd(32))}, dev=dev_b
        )
    w.clock.advance(61_000)
    pw = {"password_auth": keys.pw_auth_b64}
    for i in range(60):
        r = await w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", pw, dev=dev_a)
        assert r.status_code == 200, i
    r = await w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", pw, dev=dev_a)
    assert code(r) == "rate_limited" and int(r.headers["retry-after"]) >= 1
    w.clock.advance(61_000)
    assert (await w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", pw, dev=dev_a)).status_code == 200


async def test_failing_envelope_writes_pay_the_device_byte_budget(make_world):
    """S4: 403 write_denied is refunded from every request bucket (§5.5) but not from the device's byte
    budget, so a copy without the VK cannot push unlimited 8 MiB bodies; the real device's valid-proof
    rotate is exempt from that budget, and other devices are not affected."""
    lim = dataclasses.replace(conftest_limits(), device_envelope_bytes=(3_200_000, 3600))
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()
        other = await w.recovery_device(acct, keys)
        env = sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, 1_000_000)
        for _ in range(3):
            assert code(await w.api.put_vault(dev, keys, 1, env=env, proof=sk.b64(sk.rnd(32)))) == "write_denied"
        r = await w.api.put_vault(dev, keys, 1, env=env, proof=sk.b64(sk.rnd(32)))
        assert code(r) == "rate_limited"
        assert (await w.api.put_vault(other, keys, 1, env=env)).status_code == 200  # another device: fine
        keys.version = 2
        k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
        e2 = sk.envelope_of_size(keys.vault_id, k2.vk_id, 3, 1_000_000)
        r = await w.api.call(
            "POST",
            "/v1/keys/rotate",
            {
                "if_version": 2,
                "if_kver": 1,
                "envelope": e2[0],
                "write_proof": keys.proof(2, e2[1]),
                "new_write_key": sk.b64(k2.write_key),
                "bundle": k2.bundle(dev.device_id, kver=2),
                "password_auth": keys.pw_auth_b64,
                "recovery_verifier": k2.rec_verifier(),
                "password_verifier": k2.pw_verifier(),
                "device_names": [],
            },
            dev=dev,
        )
        assert r.status_code == 200, r.text  # the owner's remedy


async def test_envelope_writes_have_an_account_byte_budget(make_world):
    lim = dataclasses.replace(conftest_limits(), account_envelope_bytes=(3_200_000, 3600))
    async with make_world(limits=lim) as w:
        acct, dev, keys = await w.vault()
        other = await w.recovery_device(acct, keys)
        for _ in range(5):  # refused writes (403) are refunded here
            await w.api.put_vault(
                dev, keys, 1, env=sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, 1_000_000), proof=sk.b64(sk.rnd(32))
            )
        for d in (dev, other, dev):
            r = await w.api.put_vault(
                d, keys, env=sk.envelope_of_size(keys.vault_id, keys.vk_id, keys.version + 1, 1_000_000)
            )
            assert r.status_code == 200, r.text
            keys.version += 1
        r = await w.api.put_vault(
            other, keys, env=sk.envelope_of_size(keys.vault_id, keys.vk_id, keys.version + 1, 1_000_000)
        )
        assert code(r) == "rate_limited"
        w.clock.advance(3_600_001)
        assert (await w.api.put_vault(other, keys)).status_code == 200


def conftest_limits() -> RateLimits:
    import conftest

    return conftest.TEST_LIMITS


# ------------------------------------------------------------------------------------ S3: bodies


async def test_large_body_requests_wait_for_a_bounded_number_of_slots(make_world, allow_5xx):
    async with make_world(large_body_slots=1, large_body_wait_s=0.2) as w:
        acct, dev, keys = await w.vault()
        other = await w.recovery_device(acct, keys)
        first, release = held(w, "put_vault.before_tx")
        t1 = asyncio.create_task(w.api.put_vault(dev, keys, 1))
        await asyncio.wait_for(first.wait(), 10)  # holds the only slot
        r = await w.api.put_vault(other, keys, 1)
        assert code(r) == "unavailable" and r.headers["retry-after"] == "5"
        assert (await w.api.status(other)).status_code == 200  # small requests do not need a slot
        release.set()
        assert (await t1).status_code == 200
        assert (await w.api.put_vault(other, keys, 2, env=sk.envelope(keys.vault_id, keys.vk_id, 3))).status_code == 200


async def test_a_stalled_body_times_out(make_world, allow_5xx):
    async with make_world(body_timeout_s=0.2) as w:
        acct, dev, keys = await w.vault()

        async def stall():
            yield b'{"password_auth":'
            await asyncio.sleep(1)
            yield b'"x"}'

        h = {
            "Content-Type": "application/json",
            "Sixkey-Device": dev.device_id,
            "Sixkey-Ts": str(w.clock.now_ms()),
            "Sixkey-Sig": sk.b64u(b"\x01" * 64),
        }
        r = await w.http.request("DELETE", "/v1/vault/versions", content=stall(), headers=h)
        assert code(r) == "unavailable"


# ------------------------------------------------------------------------------------ S5: IP keys


async def test_ipv6_is_limited_per_64_and_mapped_ipv4_as_ipv4(make_world):
    async with make_world(limits=RateLimits(otp_send_ip=(2, 3600))) as w:

        async def send(ip, i):
            api = sk.Api(sk.client(w.app, ip), w.clock)
            try:
                return await api.call("POST", "/v1/auth/otp", {"email": sk.secret(f"v6-{i}@example.invalid")})
            finally:
                await api.http.aclose()

        assert (await send("2001:db8::1", 1)).status_code == 202
        assert (await send("2001:db8::ffff:1", 2)).status_code == 202
        assert code(await send("2001:db8::2", 3)) == "rate_limited"  # same /64
        assert (await send("2001:db8:0:1::1", 4)).status_code == 202  # the next /64
        assert (await send("198.51.100.9", 5)).status_code == 202
        assert (await send("::ffff:198.51.100.9", 6)).status_code == 202
        assert code(await send("198.51.100.9", 7)) == "rate_limited"  # mapped = the same IPv4


async def test_limiter_memory_is_pruned_and_bounded(make_world):
    async with make_world(limits=RateLimits(), limiter_max_keys=50) as w:
        lim = w.state.limiter
        for i in range(10):
            api = sk.Api(sk.client(w.app, f"198.51.100.{i + 1}"), w.clock)
            await api.call("POST", "/v1/auth/otp", {"email": sk.secret(f"gc{i}@example.invalid")})
            await api.http.aclose()
        assert any(k.startswith("oi:") for k in lim._hits)
        w.clock.advance(3_600_001)  # past the IP window (IP_COUNTER_TTL_S)
        lim.gc()
        assert not [k for k in lim._hits if k.startswith(("oi:", "oei:"))]  # no IP-keyed entries survive 1 h
        n = 0
        while len(lim._hits) < lim.max_keys:  # fill the table with fresh keys
            lim.hit(f"fill:{n}", 1, 60)
            n += 1
        assert lim.hit("fill:new", 1, 60) is not None  # refused rather than growing
        assert len(lim._hits) == lim.max_keys


class _Clock:
    def __init__(self, t):
        self.t = t

    def now_ms(self):
        return self.t


def test_limiter_counters_are_bounded_and_expire():
    """S5: the per-email OTP counters (attacker-chosen emails) are capped and live at most an hour."""
    c = _Clock(T0)
    lim = Limiter(c, max_keys=3)
    for i in range(3):
        assert lim.incr(f"ov:{i}") == 1
    assert lim.incr("ov:new") is None and "ov:new" not in lim._counters  # past the cap: refused, not stored
    assert lim.incr("ov:0") == 2  # existing keys keep counting
    c.t += COUNTER_TTL_MS
    assert lim.get("ov:0") == 0 and lim.incr("ov:1") == 1  # expired: a fresh count
    lim.gc()
    assert set(lim._counters) == {"ov:1"}  # gc dropped the expired ones


# ------------------------------------------------------------------------------------ S6: Content-Type


@pytest.mark.parametrize(
    "ctype,ok",
    [
        ("text/plain;charset=UTF-8", False),
        ("application/x-www-form-urlencoded", False),
        ("multipart/form-data; boundary=x", False),
        (None, False),
        ("application/json", True),
        ("application/json; charset=utf-8", True),
        ("APPLICATION/JSON", True),
        ("application/json;charset=UTF-8", True),
        (" application/json ; charset=utf-8 ", True),
        ("application/json; charset=latin-1", False),
        ("application/jsonx", False),
        # exactly §5.4: no alias, no quoted value, no other parameter (re-review)
        ("application/json; charset=utf8", False),
        ('application/json; charset="utf-8"', False),
        ("application/json; foo=bar", False),
        ("application/json; charset=utf-8; foo=bar", False),
        ("application/json;", False),
        ("application/json; charset = utf-8", False),
    ],
)
async def test_json_operations_require_a_json_content_type(world, ctype, ok):
    w = world
    email = sk.secret("ctype@example.invalid")
    h = {"Origin": "https://evil.example"}
    if ctype:
        h["Content-Type"] = ctype
    r = await w.http.post("/v1/auth/otp", content=sk.compact({"email": email}).encode(), headers=h)
    if ok:
        assert r.status_code == 202
    else:
        assert (r.status_code, code(r)) == (422, "invalid_request") and w.provider.last_code(email) is None


async def test_content_type_is_checked_on_signed_operations_too(world):
    w = world
    acct, dev, keys = await w.vault()
    r = await w.api.call(
        "DELETE",
        "/v1/vault/versions",
        {"password_auth": keys.pw_auth_b64},
        dev=dev,
        headers={"Content-Type": "text/plain"},
    )
    assert code(r) == "invalid_request"


# ------------------------------------------------------------------------------------ S7: deletion x write


async def wait_for_a_lock_wait(w, timeout_s=10.0):
    """Until some backend of this database is blocked on a row lock (no fixed sleep: robust under load)."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout_s
    while not await w.val(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    ):
        assert loop.time() < end, "the deletion never blocked on the device row"
        await asyncio.sleep(0.01)


def spy_delete_user(w, fail_always=False):
    real, calls = w.provider.delete_user, []

    async def spy(uid):
        if fail_always:
            calls.append("ProviderUnavailable")
            raise ProviderUnavailable()
        try:
            r = await real(uid)
        except Exception as e:
            calls.append(type(e).__name__)
            raise
        calls.append("ok")
        return r

    w.provider.delete_user = spy
    return calls


async def test_account_deletion_racing_a_write_is_retried_once_not_a_500(world):
    """S7 / A1: the cascade (users -> vaults -> devices) is the one lock order against device -> vault, so
    deleting while another device's PUT holds its device row deadlocks. The deletion waits first, so
    Postgres aborts the deletion (nothing deleted); the server retries it once and answers 204."""
    w = world
    acct, dev, keys = await w.vault()
    first, release = held(w, "put_vault.locked")
    put = asyncio.create_task(w.api.put_vault(dev, keys, 1))
    await asyncio.wait_for(first.wait(), 10)
    s = await w.login(acct.email)
    calls = spy_delete_user(w)
    dele = asyncio.create_task(
        w.api.call("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=s)
    )
    await wait_for_a_lock_wait(w)  # the cascade now waits for the device row
    release.set()
    rp, rd = await put, await dele
    assert (rp.status_code, rd.status_code) == (200, 204), (rp.text, rd.text)
    assert calls == ["ProviderUnavailable", "ok"]  # the race really happened, and one retry fixed it
    assert all(v == [] for v in (await w.rows(acct.sub)).values())


async def test_account_deletion_retries_once_then_answers_503(world, allow_5xx):
    w = world
    acct, dev, keys = await w.vault()
    s = await w.login(acct.email)
    calls = spy_delete_user(w, fail_always=True)
    r = await w.api.call("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=s)
    assert (r.status_code, code(r)) == (503, "unavailable") and r.headers["retry-after"] == "5"
    assert calls == ["ProviderUnavailable"] * 2


def test_transient_database_errors_map_to_503_and_others_to_500():
    import asyncpg
    from sixkey_server.db import map_exception

    for e in (
        asyncpg.exceptions.DeadlockDetectedError(),
        asyncpg.exceptions.SerializationError(),
        asyncpg.exceptions.ConnectionDoesNotExistError(),
        asyncpg.exceptions.TooManyConnectionsError(),
        asyncio.TimeoutError(),
        ConnectionResetError(),
    ):
        assert (map_exception(e).status, map_exception(e).code) == (503, "unavailable"), type(e).__name__
    for e in (
        asyncpg.exceptions.UniqueViolationError(),
        asyncpg.exceptions.ForeignKeyViolationError(),
        KeyError("x"),
        ValueError(),
    ):
        assert (map_exception(e).status, map_exception(e).code) == (500, "internal_error"), type(e).__name__


# ------------------------------------------------------------------------------------ S8: expected conflicts


def pg_log_offset():
    return os.path.getsize(pgutil.PG_LOG) if os.path.exists(pgutil.PG_LOG) else None


def assert_no_pg_error_since(off):
    """S8: an expected conflict is decided with ON CONFLICT DO NOTHING, never as an ERROR in the server
    log (its DETAIL would carry ids unless the log is terse). test_zz_logs checks the whole run as well."""
    if off is None:
        return
    with open(pgutil.PG_LOG, encoding="utf-8", errors="replace") as f:
        f.seek(off)
        text = f.read()
    assert "ERROR" not in text, text[-300:]


def on_first(w, name, action):
    """At the first arrival at pause point `name`, run `action` to completion: a deterministic race."""
    out = {}

    async def hook():
        if "r" not in out:
            out["r"] = None
            out["r"] = await action()

    w.state.hooks[name] = hook
    return out


def init_body(dev, keys):
    keys.bundle_text = keys.bundle(dev.device_id)
    return {
        "vault_id": keys.vault_id,
        "envelope": sk.envelope(keys.vault_id, keys.vk_id, 1)[0],
        "bundle": keys.bundle_text,
        "recovery_verifier": keys.rec_verifier(),
        "password_verifier": keys.pw_verifier(),
        "write_key": sk.b64(keys.write_key),
        "device": {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "name_ct": keys.name_ct()},
    }


@pytest.mark.parametrize("same_body", [True, False])
async def test_concurrent_init_of_one_account_is_decided_again_without_an_error(world, same_body):
    """A double-submitted init (same body: both 201, idempotent) or two different first devices racing
    (vault_exists for the loser): the loser's insert meets the winner's row and decides again."""
    w = world
    acct = await w.login()
    s2 = await w.login(acct.email)
    d1, k1 = sk.Dev(), sk.new_vault_keys(w.hour())
    b1 = init_body(d1, k1)
    b2, d2 = (b1, d1) if same_body else (init_body(d := sk.Dev(), sk.new_vault_keys(w.hour())), d)
    off = pg_log_offset()
    other = on_first(w, "init.checked", lambda: w.api.call("POST", "/v1/vault/init", b2, acct=s2, reg=d2))
    r = await w.api.call("POST", "/v1/vault/init", b1, acct=acct, reg=d1)
    assert other["r"].status_code == 201  # the other init committed while this one waited
    assert (r.status_code, code(r)) == ((201, None) if same_body else (409, "vault_exists"))
    assert await w.val("SELECT count(*) FROM sixkey.devices WHERE user_id = $1", uuid.UUID(acct.sub)) == 1
    assert_no_pg_error_since(off)


async def test_init_racing_for_a_device_id_is_device_exists_and_rolls_back(world):
    w = world
    a, b = await w.login(), await w.login()
    d = sk.Dev()
    off = pg_log_offset()
    other = on_first(w, "init.checked", lambda: w.api.init(b, d, sk.new_vault_keys(w.hour())))
    r = await w.api.init(a, d, sk.new_vault_keys(w.hour()))
    assert other["r"].status_code == 201 and code(r) == "device_exists"
    assert await w.val("SELECT count(*) FROM sixkey.vaults WHERE user_id = $1", uuid.UUID(a.sub)) == 0
    assert_no_pg_error_since(off)


async def test_complete_racing_for_a_device_id_is_enroll_state_and_the_request_survives(world):
    w = world
    acct, dev_a, keys = await w.vault()
    n, s = sk.Dev(), await w.login(acct.email)
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": n.device_id, "sig_pubkey": n.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=s,
        reg=n,
    )
    rid = r.json()["request_id"]
    b = await w.login()
    off = pg_log_offset()
    other = on_first(w, "complete.before_insert", lambda: w.api.init(b, n, sk.new_vault_keys(w.hour())))
    r = await w.api.call("POST", f"/v1/enroll/requests/{rid}/complete", {"name_ct": keys.name_ct()}, enroll=(rid, n))
    assert other["r"].status_code == 201 and code(r) == "enroll_state"
    assert await w.val("SELECT count(*) FROM sixkey.enrollments WHERE request_id = $1", uuid.UUID(rid)) == 1
    assert_no_pg_error_since(off)


async def test_fork_racing_for_a_device_id_is_device_exists(world):
    w = world
    acct, dev, keys = await w.vault()
    new, b = sk.Dev(), await w.login()
    off = pg_log_offset()
    other = on_first(w, "fork.before_insert", lambda: w.api.init(b, new, sk.new_vault_keys(w.hour())))
    r = await w.api.call(
        "POST",
        "/v1/devices/fork",
        {
            "new_device_id": new.device_id,
            "new_sig_pubkey": new.spki_b64,
            "name_ct": keys.name_ct(),
            "password_auth": keys.pw_auth_b64,
        },
        dev=dev,
        new_sig=new,
    )
    assert other["r"].status_code == 201 and code(r) == "device_exists"
    assert_no_pg_error_since(off)


async def test_sequential_expected_conflicts_leave_no_error_in_the_postgres_log(world):
    w = world
    acct, dev_a, keys = await w.vault()
    session = await w.login(acct.email)
    off = pg_log_offset()
    f1 = await w.start_approval(acct, session)
    assert code(await type(f1)(w, session).create()) == "one_per_session"
    n = sk.Dev()
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": n.device_id, "sig_pubkey": n.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=session,
        reg=n,
    )
    assert code(r) == "one_per_session"
    assert code(await w.api.init(await w.login(), dev_a, sk.new_vault_keys(w.hour()))) == "device_exists"
    assert_no_pg_error_since(off)


# ------------------------------------------------------------------------------------ S10: pool


async def test_pool_exhaustion_is_503_after_the_acquire_timeout(make_world, allow_5xx):
    async with make_world(db_pool_max=1, db_acquire_timeout_s=0.3) as w:
        acct, dev, keys = await w.vault()
        first, release = held(w, "put_vault.locked")
        put = asyncio.create_task(w.api.put_vault(dev, keys, 1))
        await asyncio.wait_for(first.wait(), 10)  # the only connection is in that transaction
        try:
            r = await asyncio.wait_for(w.api.status(dev), 3)
        finally:
            release.set()
        assert code(r) == "unavailable" and r.headers["retry-after"] == "5"
        assert (await put).status_code == 200


# ------------------------------------------------------------------------------------ S12: environment


def test_the_environment_must_be_explicit_and_the_fake_provider_never_runs_in_production(monkeypatch, db):
    for k in ("SIXKEY_ENV",):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SIXKEY_DATABASE_DSN", db.api)
    with pytest.raises(SystemExit):
        Settings.from_env()
    assert Settings(database_dsn="x").env == "production"
    monkeypatch.setenv("SIXKEY_ENV", "staging")
    with pytest.raises(SystemExit):
        Settings.from_env()
    # production: the lifespan refuses to build the fake provider
    from sixkey_server.main import create_app

    app = create_app(Settings(database_dsn=db.api, fake_auth_dsn=db.fake_auth))

    async def boot():
        events = iter([{"type": "lifespan.startup"}])
        sent = []

        async def receive():
            return next(events, {"type": "lifespan.shutdown"})

        async def send(m):
            sent.append(m)

        await app({"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send)

    with pytest.raises(SystemExit, match="FakeAuthProvider is local only"):
        asyncio.run(boot())
    # dev on a non-loopback address: refused before uvicorn starts
    import sixkey_server.__main__ as entry

    monkeypatch.setenv("SIXKEY_ENV", "dev")
    monkeypatch.setenv("SIXKEY_BIND", "0.0.0.0:8787")
    monkeypatch.setattr(entry.uvicorn, "run", lambda *a, **k: pytest.fail("must not start"))
    with pytest.raises(SystemExit):
        entry.main()
    # production may bind any address; without a trusted proxy it warns (P3); uvicorn gets its limits (S3)
    monkeypatch.setenv("SIXKEY_ENV", "production")
    started, events = {}, []
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **k: started.update(k))
    monkeypatch.setattr(entry.applog, "emit", lambda **f: events.append(f))
    monkeypatch.setattr(entry.applog, "configure", lambda: None)
    entry.main()
    assert started["host"] == "0.0.0.0" and started["limit_concurrency"] == 256 and started["timeout_keep_alive"] == 5
    assert started["access_log"] is False and started["proxy_headers"] is False
    assert events == [{"event": "warning_no_trusted_proxy"}]
    # the daily job uses the FakeAuthProvider too: refused in production
    import sixkey_server.jobs as jobs

    with pytest.raises(SystemExit, match="FakeAuthProvider is local only"):
        asyncio.run(jobs._main())


# ------------------------------------------------------------------------------------ T2: races


async def test_clear_history_racing_a_revocation(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    for _ in range(2):
        await w.api.put_vault(dev_a, keys)
        keys.version += 1
    first, release = held(w, "delete_versions.before_tx")
    t = asyncio.create_task(w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev_b))
    await asyncio.wait_for(first.wait(), 10)
    del w.state.hooks["delete_versions.before_tx"]
    assert (
        await w.api.call(
            "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
        )
    ).status_code == 200
    release.set()
    r = await t
    assert code(r) == "device_revoked"
    assert await w.val("SELECT count(*) FROM sixkey.vault_versions") == 3


async def test_clear_history_racing_a_put_keeps_the_head(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    await w.api.put_vault(dev_a, keys)
    keys.version = 2
    first, release = held(w, "delete_versions.locked")
    t = asyncio.create_task(w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev_a))
    await asyncio.wait_for(first.wait(), 10)  # holds the vault row
    put = asyncio.create_task(w.api.put_vault(dev_b, keys, 2))
    await asyncio.sleep(0.2)
    assert not put.done()  # the PUT waits for the vault row
    release.set()
    r, rp = await t, await put
    assert r.json()["deleted"] == 1 and rp.status_code == 200
    head = await w.val("SELECT version FROM sixkey.vaults")
    assert head == 3 and [
        x["version"] for x in await w.sql("SELECT version FROM sixkey.vault_versions ORDER BY 1")
    ] == [2, 3]


async def test_put_keys_racing_a_revocation(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    body = {
        "if_kver": 1,
        "bundle": keys.bundle(dev_b.device_id, kver=2),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": keys.rec_verifier(sk.rnd(32)),
    }
    first, release = held(w, "put_keys.before_tx")
    t = asyncio.create_task(w.api.call("PUT", "/v1/keys", body, dev=dev_b))
    await asyncio.wait_for(first.wait(), 10)
    del w.state.hooks["put_keys.before_tx"]
    assert (
        await w.api.call(
            "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
        )
    ).status_code == 200
    release.set()
    assert code(await t) == "device_revoked"
    assert await w.val("SELECT kver FROM sixkey.vaults") == 1


async def test_rotate_racing_a_put_keys_loses_the_kver_cas(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope(keys.vault_id, k2.vk_id, 2)
    rot_body = {
        "if_version": 1,
        "if_kver": 1,
        "envelope": env[0],
        "write_proof": keys.proof(1, env[1]),
        "new_write_key": sk.b64(k2.write_key),
        "bundle": k2.bundle(dev_a.device_id, kver=2),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": k2.rec_verifier(),
        "password_verifier": k2.pw_verifier(),
        "device_names": [],
    }
    first, release = held(w, "rotate.before_tx")
    rot = asyncio.create_task(w.api.call("POST", "/v1/keys/rotate", rot_body, dev=dev_a))
    await asyncio.wait_for(first.wait(), 10)
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    kb = {
        "if_kver": 1,
        "bundle": keys.bundle(dev_b.device_id, kver=5),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": keys.rec_verifier(sk.rnd(32)),
    }
    assert (await w.api.call("PUT", "/v1/keys", kb, dev=dev_b)).status_code == 200
    release.set()
    r = await rot
    assert code(r) == "keys_conflict"
    v = (await w.sql("SELECT kver, bundle, vk_id FROM sixkey.vaults"))[0]
    assert (v["kver"], v["bundle"], v["vk_id"]) == (5, kb["bundle"], keys.vk_id)


# ------------------------------------------------------------------------------------ T3


async def test_rotate_compares_by_with_the_signer(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope(keys.vault_id, k2.vk_id, 2)
    r = await w.api.call(
        "POST",
        "/v1/keys/rotate",
        {
            "if_version": 1,
            "if_kver": 1,
            "envelope": env[0],
            "write_proof": keys.proof(1, env[1]),
            "new_write_key": sk.b64(k2.write_key),
            "bundle": k2.bundle(dev_b.device_id, kver=2),
            "password_auth": keys.pw_auth_b64,
            "recovery_verifier": k2.rec_verifier(),
            "password_verifier": k2.pw_verifier(),
            "device_names": [],
        },
        dev=dev_a,
    )
    assert code(r) == "invalid_request"
    assert await w.val("SELECT version FROM sixkey.vaults") == 1


@pytest.mark.parametrize("member", ["mac", "at"])
async def test_idempotency_is_byte_for_byte_not_by_kver(world, member):
    w = world
    acct, dev, keys = await w.vault()
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    body = {
        "if_kver": 1,
        "bundle": keys.bundle(dev.device_id, kver=2),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": keys.rec_verifier(sk.rnd(32)),
    }
    assert (await w.api.call("PUT", "/v1/keys", body, dev=dev)).status_code == 200
    b = json.loads(body["bundle"])
    b[member] = sk.b64(sk.rnd(32)) if member == "mac" else b["at"] - HOUR
    other = dict(body, bundle=sk.compact(b))  # same kver, one member different
    r = await w.api.call("PUT", "/v1/keys", other, dev=dev)
    assert code(r) == "keys_conflict"


def test_the_byte_cap_never_drops_the_head():
    rows = [(v, T0 - (10 - v) * HOUR, 5000) for v in range(1, 11)]
    kept = select_kept(rows, T0, Policy(keep_versions=30, keep_days=30, max_bytes=1000))
    assert kept == {10}


# ------------------------------------------------------------------------------------ I2: session claims


@pytest.mark.parametrize(
    "over",
    [
        {"aud": ["authenticated", "other"]},
        {"role": None},
        {
            "aud": "authenticated ",
        },
    ],
)
async def test_session_claims_are_exact(world, over):
    w = world
    acct = await w.login()
    c = {
        "iss": w.provider.issuer,
        "aud": "authenticated",
        "sub": acct.sub,
        "iat": T0 // 1000,
        "exp": T0 // 1000 + 900,
        "session_id": sk.uuid4(),
        "role": "authenticated",
        "is_anonymous": False,
    }
    c.update(over)
    tok = w.provider.sign({k: v for k, v in c.items() if v is not None})
    r = await w.http.get("/v1/account", headers={"Authorization": f"Bearer {tok}"})
    assert code(r) == "session_invalid"


# ------------------------------------------------------------------------------------ S14: the strict oracle


_TEXT = {"type": "string", "contentMediaType": "application/json", "contentSchema": {"type": "object"}}


@pytest.mark.parametrize(
    "text",
    [
        '{"kver":2.0}',
        '{"a":1,"a":1}',
        '{"a":NaN}',
        '{"a":9007199254740992}',
        '{"a":-9007199254740992}',
        '{"a":1e3}',
        '{"a":-0.0}',
        '{"a":Infinity}',
        '{"a":"\\u0000"}',
        '{"a":"\\ud800"}',
        '{"\\udc00":1}',
        '{"a":{"b":1,"\\u0062":2}}',
    ],
)
def test_both_text_oracles_reject_non_strict_json(text):
    """S14: contract/py's validate() and the independent sk.strict_json agree on every rejected text."""
    assert sk.SC.validate(_TEXT, text, sk.OPENAPI) != []
    with pytest.raises((sk.NotStrict, UnicodeEncodeError)):
        sk.strict_json(text)


@pytest.mark.parametrize(
    "text",
    [
        '{"a":9007199254740991}',
        '{"a":-9007199254740991}',
        '{"a":"\\ud83d\\ude00"}',
        '{"a":[1,{"a":1}]}',
        '{"a":"\\u0001"}',
        "{}",
    ],
)
def test_both_text_oracles_accept_strict_json(text):
    assert sk.SC.validate(_TEXT, text, sk.OPENAPI) == []
    sk.strict_json(text)


# ------------------------------------------------------------------------------------ replays (A2)


def signed_headers(w, method, path, body: bytes, *, dev=None, acct=None, reg=None):
    ts = w.clock.now_ms()
    h = {"Content-Type": "application/json", "Sixkey-Ts": str(ts)}
    key = dev or reg
    h["Sixkey-Device"] = key.device_id
    if acct is not None:
        h["Authorization"] = f"Bearer {acct.token}"
    h["Sixkey-Sig"] = key.sign(sk.signing_input(method, path, key.device_id, acct.sub if acct else "-", ts, body))
    return h


async def test_replayed_reject_all_spares_requests_opened_after_it(world):
    """The one-line mitigation: reject-all deletes only requests created at or before the minute of its
    signed Sixkey-Ts."""
    w = world
    acct, dev_a, keys = await w.vault()
    early = await w.start_approval(acct)
    body = sk.compact({"password_auth": keys.pw_auth_b64}).encode()
    h = signed_headers(w, "POST", "/v1/enroll/reject-all", body, dev=dev_a)
    r = await w.http.post("/v1/enroll/reject-all", content=body, headers=h)
    assert r.json()["rejected"] == 1 and code(await early.poll()) == "enroll_gone"
    w.clock.advance(60_000)
    later = await w.start_approval(acct)  # a legitimate new request, the next minute
    r = await w.http.post("/v1/enroll/reject-all", content=body, headers=h)  # the replay, inside the window
    assert r.status_code == 200 and r.json()["rejected"] == 0
    assert (await later.poll()).status_code == 200
    r = await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert r.json()["rejected"] == 1  # a fresh reject-all still rejects everything


async def test_residual_replayed_clear_history_erases_history_written_since(world):
    w = world
    acct, dev, keys = await w.vault()
    body = sk.compact({"password_auth": keys.pw_auth_b64}).encode()
    h = signed_headers(w, "DELETE", "/v1/vault/versions", body, dev=dev)
    assert (await w.http.request("DELETE", "/v1/vault/versions", content=body, headers=h)).status_code == 200
    for _ in range(3):
        await w.api.put_vault(dev, keys)
        keys.version += 1
    r = await w.http.request("DELETE", "/v1/vault/versions", content=body, headers=h)
    assert r.json()["deleted"] == 3  # documented residual (A2): needs the captured request


async def test_residual_replayed_enrollment_create_after_a_reject(world):
    w = world
    acct, dev_a, keys = await w.vault()
    s = await w.login(acct.email)
    n = sk.Dev()
    body = sk.compact({"device_id": n.device_id, "sig_pubkey": n.spki_b64, "commit": sk.b64(sk.rnd(32))}).encode()
    h = signed_headers(w, "POST", "/v1/enroll/requests", body, acct=s, reg=n)
    rid = (await w.http.post("/v1/enroll/requests", content=body, headers=h)).json()["request_id"]
    await w.api.call("POST", f"/v1/enroll/requests/{rid}/reject", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    w.clock.advance(120_000)
    r = await w.http.post("/v1/enroll/requests", content=body, headers=h)
    assert r.status_code == 201 and r.json()["request_id"] != rid  # residual: a phantom pending request (A2)


async def test_residual_replayed_recovery_enrollment_after_reject_all(world):
    w = world
    acct, dev_a, keys = await w.vault()
    s = await w.login(acct.email)
    n = sk.Dev()
    body = sk.compact({"device_id": n.device_id, "sig_pubkey": n.spki_b64, "recovery_auth": keys.rec_auth_b64}).encode()
    h = signed_headers(w, "POST", "/v1/enroll/recovery", body, acct=s, reg=n)
    assert (await w.http.post("/v1/enroll/recovery", content=body, headers=h)).status_code == 200
    w.clock.advance(60_000)
    await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    r = await w.http.post("/v1/enroll/recovery", content=body, headers=h)
    assert r.status_code == 200 and "envelope" in r.json()  # residual (A2): needs the request with the code


async def test_residual_replayed_rename_restores_the_older_name(world):
    """The case §5.2 always named: a captured rename replayed inside the window undoes a later rename."""
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    first = {"name_ct": keys.name_ct(), "password_auth": keys.pw_auth_b64}
    body = sk.compact(first).encode()
    path = f"/v1/devices/{dev_b.device_id}"
    h = signed_headers(w, "PATCH", path, body, dev=dev_a)
    assert (await w.http.patch(path, content=body, headers=h)).status_code == 200
    w.clock.advance(60_000)
    second = keys.name_ct()
    r = await w.api.call("PATCH", path, {"name_ct": second, "password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert r.status_code == 200
    assert (await w.http.patch(path, content=body, headers=h)).status_code == 200  # the replay
    devs = {d["device_id"]: d for d in (await w.api.call("GET", "/v1/devices", dev=dev_a)).json()["devices"]}
    assert devs[dev_b.device_id]["name_ct"] == first["name_ct"]  # residual (A2)


async def test_residual_signed_gets_replay_inside_the_window_only(world):
    w = world
    acct, dev, keys = await w.vault()
    h = signed_headers(w, "GET", "/v1/keys", b"", dev=dev)
    del h["Content-Type"]
    assert (await w.http.get("/v1/keys", headers=h)).status_code == 200
    w.clock.advance(299_000)
    assert (await w.http.get("/v1/keys", headers=h)).status_code == 200  # residual (A2)
    w.clock.advance(2_000)
    assert code(await w.http.get("/v1/keys", headers=h)) == "clock_skew"
