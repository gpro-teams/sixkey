"""Regressions for the re-review of the fix pass (docs/audit/internal-reviews/M4-REREVIEW.md, RR1-RR6) and its nine probes
(review copy: tests/test_rr_probes.py), in this suite's style.

The probes asserted what the server did. Here RR1 and RR3 assert the fixed behaviour; the others pin
residuals that are documented (docs/design/notes/M4-NOTES.md §11) and accepted for now, so a change is noticed.
"""

from __future__ import annotations

import asyncio
import dataclasses

import pytest

import sk
from sixkey_server.config import RateLimits
from test_review import allow_5xx, held, init_body, signed_headers  # noqa: F401  (allow_5xx is a fixture)


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


def limits(**kw) -> RateLimits:
    import conftest

    return dataclasses.replace(conftest.TEST_LIMITS, **kw)


def dup_key(envelope_text: str) -> str:
    """The same envelope text with a duplicate member: strict JSON refuses it (422) only after the
    body has been read and the signature verified."""
    return envelope_text[:-1] + ',"vaultId":"x"}'


def rotate_body(keys, dev, envelope_text: str, *, if_version: int = 1) -> dict:
    return {
        "if_version": if_version,
        "if_kver": 1,
        "envelope": envelope_text,
        "write_proof": sk.b64(sk.rnd(32)),
        "new_write_key": sk.b64(sk.rnd(32)),
        "bundle": keys.bundle(dev.device_id, kver=2),
        "password_auth": sk.b64(sk.rnd(32)),
        "recovery_verifier": keys.rec_verifier(),
        "password_verifier": keys.pw_verifier(),
        "device_names": [],
    }


# ------------------------------------------------------------------------------------ RR1: byte budgets


async def test_a_rotate_whose_body_does_not_parse_pays_the_byte_budgets(make_world):
    """Probe P1. A copy (device key, no password) sending 1 MB rotates with a broken envelope text: each
    is 422, and each pays the device byte budget (never refunded), the device write bucket and the
    account byte budget, so the 422 path is no longer free."""
    async with make_world(limits=limits(device_envelope_bytes=(3_200_000, 3600))) as w:
        acct, dev, keys = await w.vault()
        bad = rotate_body(keys, dev, dup_key(sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, 1_000_000)[0]))
        for i in range(3):
            r = await w.api.call("POST", "/v1/keys/rotate", bad, dev=dev)
            assert (r.status_code, code(r)) == (422, "invalid_request"), i
        L = w.state.limiter
        assert L.count("eb:" + dev.device_id) > 3_000_000 and L.count("dw:" + dev.device_id) == 3
        assert L.count(L.hkey("ab", acct.sub)) > 3_000_000
        r = await w.api.call("POST", "/v1/keys/rotate", bad, dev=dev)
        assert code(r) == "rate_limited" and int(r.headers["retry-after"]) >= 1
        # a body that is not even JSON pays too (another device: its own budget, the same account)
        other = await w.recovery_device(acct, keys)
        r = await w.api.call("POST", "/v1/keys/rotate", raw=b"{" + b"x" * 1_000_000, dev=other)
        assert code(r) == "invalid_request" and L.count("eb:" + other.device_id) > 1_000_000


async def test_init_pays_a_byte_budget_per_session_never_the_accounts(make_world):
    """init has no device row yet (its device id is the client's choice), so no device budget; and not
    the account's budget either: a session needs only the email, and whoever holds the email must not
    be able to use up what the account's devices write against (D2). init pays its session's budget,
    parsed or not."""
    lim = limits(session_envelope_bytes=(2_500_000, 3600), account_envelope_bytes=(2_500_000, 3600))
    async with make_world(limits=lim) as w:
        acct = await w.login()
        dev, keys = sk.Dev(), sk.new_vault_keys(w.hour())
        body = init_body(dev, keys)
        body["envelope"] = sk.envelope_of_size(keys.vault_id, keys.vk_id, 1, 1_000_000)[0]
        assert (await w.api.call("POST", "/v1/vault/init", body, acct=acct, reg=dev)).status_code == 201
        L = w.state.limiter
        assert L.count(L.hkey("ab", acct.sub)) == 0 and L.count("eb:" + dev.device_id) == 0
        # the email holder floods init with envelopes that do not parse (and with retries that are 409)
        bad = dict(body, envelope=dup_key(body["envelope"]))
        assert code(await w.api.call("POST", "/v1/vault/init", bad, acct=acct, reg=dev)) == "invalid_request"
        assert code(await w.api.call("POST", "/v1/vault/init", body, acct=acct, reg=dev)) == "rate_limited"
        assert L.count(L.hkey("ab", acct.sub)) == 0
        # the owner's device still writes its full account budget
        for v in (1, 2):
            r = await w.api.put_vault(
                dev, keys, v, env=sk.envelope_of_size(keys.vault_id, keys.vk_id, v + 1, 1_000_000)
            )
            assert r.status_code == 200, r.text
        # another session has a budget of its own (the identical retry is the idempotent 201)
        s2 = await w.login(acct.email)
        assert (await w.api.call("POST", "/v1/vault/init", body, acct=s2, reg=dev)).status_code == 201


# ------------------------------------------------------------------------------------ RR3: full counter table


async def test_a_full_counter_table_answers_429_on_verify(make_world):
    """Probe P3. The contract's limiter rule: a request that needs a new key once a table is full gets
    429. The per-email verify counter is such a key; it used to become a silent otp_invalid."""
    async with make_world(limiter_max_keys=50) as w:
        email = sk.secret("full@example.invalid")
        assert (await w.api.call("POST", "/v1/auth/otp", {"email": email})).status_code == 202
        right = w.provider.last_code(email)
        L = w.state.limiter
        i = 0
        while len(L._counters) < L.max_keys:
            assert L.incr(f"fill:{i}") == 1
            i += 1
        r = await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": right})
        assert (r.status_code, code(r)) == (429, "rate_limited") and r.headers["retry-after"] == "60"
        L._counters.clear()  # room again (gc, the next day): the code still works
        assert (await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": right})).status_code == 200


async def test_residual_a_full_window_table_refuses_new_device_buckets(make_world):
    """Probe P3b (RR3b). One table for every key family: once IP and email keys fill it, a device whose
    bucket had expired cannot get a new one until gc frees room (429, never unlimited)."""
    async with make_world(limiter_max_keys=200) as w:
        acct, dev, keys = await w.vault()
        L = w.state.limiter
        n = 0
        while len(L._hits) < L.max_keys:
            L.hit(f"oi:fill{n}", 1, 3600)
            n += 1
        r = await w.api.status(dev)
        assert (r.status_code, code(r)) == (429, "rate_limited") and r.headers["retry-after"] == "60"


# ------------------------------------------------------------------------------------ RR2: large-body slots


async def test_residual_large_body_slots_are_shared_by_all_accounts(make_world, allow_5xx):
    """Probe P2 (RR2). The slots bound memory for the whole process, not per account: while account A
    holds the only slot, account B's PUT waits and gets 503. Per-source fairness is M8 (the proxy)."""
    async with make_world(large_body_slots=1, large_body_wait_s=0.2) as w:
        acct_a, dev_a, keys_a = await w.vault()
        acct_b, dev_b, keys_b = await w.vault()
        first, release = held(w, "put_vault.before_tx")
        t = asyncio.create_task(w.api.put_vault(dev_a, keys_a, 1))
        await asyncio.wait_for(first.wait(), 10)
        try:
            r = await w.api.put_vault(dev_b, keys_b, 1)
        finally:
            release.set()
        assert code(r) == "unavailable" and r.headers["retry-after"] == "5"
        assert (await t).status_code == 200


async def test_residual_a_known_device_id_takes_a_slot_before_its_signature_is_checked(make_world, allow_5xx):
    """Probe P2b (RR2, the S3 residual). The signature covers the body, so it can only be verified after
    the body is read, and a 9 MiB body needs a slot first: a known device id with a wrong signature
    still waits for one. Bounded by the slots, the body timeout and the proxy (M8)."""
    async with make_world(large_body_slots=1, large_body_wait_s=0.2) as w:
        acct, dev, keys = await w.vault()
        first, release = held(w, "put_vault.before_tx")
        t = asyncio.create_task(w.api.put_vault(dev, keys, 1))
        await asyncio.wait_for(first.wait(), 10)
        body = {
            "if_version": 1,
            "envelope": sk.envelope_of_size(keys.vault_id, keys.vk_id, 2, 1_000_000)[0],
            "write_proof": sk.b64(sk.rnd(32)),
            "cursor": {"pending": sk.b64(sk.rnd(16))},
        }
        h = {"Sixkey-Ts": str(w.clock.now_ms()), "Sixkey-Sig": sk.b64u(dev.sign_p1363(b"not the signing input"))}
        try:
            r = await w.api.call("PUT", "/v1/vault", body, dev=dev, sign=False, headers=h)
        finally:
            release.set()
        assert code(r) == "unavailable"  # it waited for the slot, not refused as unsigned
        await t
        r = await w.api.call("PUT", "/v1/vault", body, dev=dev, sign=False, headers=h)
        assert code(r) == "bad_signature"  # with a free slot: read, verified, refused


# ------------------------------------------------------------------------------------ RR6: OTP buckets


async def test_residual_any_ip_can_spend_an_emails_five_verify_attempts(make_world):
    """Probe P9 (RR6, accepted for Phase 1; M8 chooses the mitigation). The per-code counter is keyed by
    email only, so wrong guesses from any IP kill the victim's current code; a new code works again."""
    async with make_world(limits=RateLimits()) as w:
        victim = sk.secret("burn@example.invalid")
        assert (await w.api.call("POST", "/v1/auth/otp", {"email": victim})).status_code == 202
        right = w.provider.last_code(victim)
        wrong = "000000" if right != "000000" else "111111"
        attacker = sk.Api(sk.client(w.app, "198.51.100.200"), w.clock)
        try:
            for _ in range(5):
                assert (
                    code(await attacker.call("POST", "/v1/auth/verify", {"email": victim, "token": wrong}))
                    == "otp_invalid"
                )
        finally:
            await attacker.http.aclose()
        assert code(await w.api.call("POST", "/v1/auth/verify", {"email": victim, "token": right})) == "otp_invalid"
        assert (await w.api.call("POST", "/v1/auth/otp", {"email": victim})).status_code == 202
        r = await w.api.call("POST", "/v1/auth/verify", {"email": victim, "token": w.provider.last_code(victim)})
        assert r.status_code == 200


async def test_residual_many_ips_can_fill_an_emails_daily_send_bucket(make_world):
    """Probe P9b (RR6). otp_send_email_day counts one email across all IPs: enough attacker IPs fill it
    and the victim's own send is 429 until the window frees (shown with a limit of 3 instead of 50)."""
    async with make_world(limits=RateLimits(otp_send_email_day=(3, 86_400))) as w:
        victim = sk.secret("lockout@example.invalid")
        for i in range(3):
            a = sk.Api(sk.client(w.app, f"203.0.113.{100 + i}"), w.clock)
            try:
                assert (await a.call("POST", "/v1/auth/otp", {"email": victim})).status_code == 202
            finally:
                await a.http.aclose()
        v = sk.Api(sk.client(w.app, "198.51.100.77"), w.clock)
        try:
            r = await v.call("POST", "/v1/auth/otp", {"email": victim})
            assert code(r) == "rate_limited" and int(r.headers["retry-after"]) > 80_000
            w.clock.advance(86_400_001)
            assert (await v.call("POST", "/v1/auth/otp", {"email": victim})).status_code == 202
        finally:
            await v.http.aclose()


async def test_a_new_code_brings_five_more_attempts_at_the_price_of_a_resend(world):
    """Probe P8 (A22). A resend resets the email's counter, so guesses in flight across a resend reach
    the provider 5 + 5 times, never more; each further batch costs a rate-limited send that mails the
    victim. Deterministic: the resend happens once the first five are inside the provider."""
    w = world
    email = sk.secret("reset@example.invalid")
    assert (await w.api.call("POST", "/v1/auth/otp", {"email": email})).status_code == 202
    real, reached, five_in = w.provider.verify_otp, {"n": 0}, asyncio.Event()

    async def slow_verify(e, t):
        reached["n"] += 1
        if reached["n"] == 5:
            five_in.set()
        await asyncio.sleep(0.05)
        return await real(e, t)

    w.provider.verify_otp = slow_verify

    def guesses(n, right):  # wrong on purpose
        return [
            asyncio.create_task(w.api.call("POST", "/v1/auth/verify", {"email": email, "token": t}))
            for t in [f"{i:06d}" for i in range(n + 1) if f"{i:06d}" != right][:n]
        ]

    tasks = guesses(6, w.provider.last_code(email))  # five reach the provider, one does not
    await asyncio.wait_for(five_in.wait(), 10)
    assert (await w.api.call("POST", "/v1/auth/otp", {"email": email})).status_code == 202
    tasks += guesses(6, w.provider.last_code(email))
    rs = await asyncio.gather(*tasks)
    assert all(code(r) == "otp_invalid" for r in rs) and reached["n"] == 10


# ------------------------------------------------------------------------------------ reject-all and the clock


async def test_reject_all_signed_by_a_fast_clock_reaches_requests_opened_after_it(world):
    """Probe P7. reject-all's bound is the signed Sixkey-Ts. A device whose clock runs 300 s ahead signs
    a future bound, so a replay inside the window also rejects requests opened after the original:
    the reason §4.14 now requires signing with the corrected clock."""
    w = world
    acct, dev, keys = await w.vault()
    body = sk.compact({"password_auth": keys.pw_auth_b64}).encode()
    w.clock.advance(300_000)
    h = signed_headers(w, "POST", "/v1/enroll/reject-all", body, dev=dev)  # signed 300 s in the future
    w.clock.advance(-300_000)
    assert (await w.http.post("/v1/enroll/reject-all", content=body, headers=h)).status_code == 200
    w.clock.advance(60_000)
    later = await w.start_approval(acct)
    r = await w.http.post("/v1/enroll/reject-all", content=body, headers=h)  # the replay
    assert r.json()["rejected"] == 1 and code(await later.poll()) == "enroll_gone"
