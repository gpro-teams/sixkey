"""Email OTP, GET /v1/account, and account deletion (§3.12, §5.2, §5.7, F12)."""

from __future__ import annotations

import pytest

import sk


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


async def test_otp_is_202_for_any_address_and_creates_an_unconfirmed_user(world):
    w = world
    for e in ("new-one@example.invalid", "New-One@Example.Invalid"):
        r = await w.api.call("POST", "/v1/auth/otp", {"email": sk.secret(e)})
        assert r.status_code == 202 and set(r.json()) == {"server_time"}
    rows = await w.sql("SELECT email, email_confirmed_at FROM auth.users")
    assert [(r["email"], r["email_confirmed_at"]) for r in rows] == [("new-one@example.invalid", None)]


@pytest.mark.parametrize(
    "email",
    [
        "plainaddress",
        "a@b",
        "a@@example.invalid",
        "a b@example.invalid",
        ".a@example.invalid",
        "a..b@example.invalid",
        "a@-example.invalid",
        "a@example.invalid\n",
        "x" * 65 + "@example.invalid",
    ],
)
async def test_invalid_email_is_400(world, email):
    r = await world.api.call("POST", "/v1/auth/otp", {"email": email})
    assert (r.status_code, code(r)) == (400, "invalid_email")


@pytest.mark.parametrize(
    "body",
    [{}, {"email": "a@example.invalid", "x": 1}, {"email": 5}, {"email": "ab"}, [], {"email": "a" * 250 + "@ex.io"}],
)
async def test_malformed_otp_body_is_422(world, body):
    r = await world.api.call("POST", "/v1/auth/otp", body)
    assert (r.status_code, code(r)) == (422, "invalid_request")


async def test_verify_wrong_reused_and_malformed(world):
    w = world
    email = sk.secret("v2@example.invalid")
    await w.api.call("POST", "/v1/auth/otp", {"email": email})
    good = w.provider.last_code(email)
    assert code(await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": "12345"})) == "invalid_request"
    assert (await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": good})).status_code == 200
    assert (
        code(await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": good})) == "otp_invalid"
    )  # single use
    assert (
        code(await w.api.call("POST", "/v1/auth/verify", {"email": "nobody@example.invalid", "token": good}))
        == "otp_invalid"
    )


async def test_account_reads(world):
    w = world
    acct = await w.login()
    r = await w.api.call("GET", "/v1/account", acct=acct)
    assert r.json() == {"has_vault": False, "server_time": r.json()["server_time"]}
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    await w.api.call("POST", f"/v1/devices/{other.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev)
    r = await w.api.call("GET", "/v1/account", acct=acct)
    assert r.json()["device_count"] == 1  # unrevoked devices


async def test_failed_auth_delete_deletes_nothing_and_can_be_retried(world):
    w = world
    acct, dev, keys = await w.vault()
    await w.recovery_device(acct, keys)
    before = await w.rows(acct.sub)
    fresh = await w.login(acct.email)
    w.provider.fail_delete = True
    sk.ALLOW_5XX["value"] = True
    try:
        r = await w.api.call("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=fresh)
    finally:
        sk.ALLOW_5XX["value"] = False
    assert (r.status_code, code(r)) == (500, "internal_error")
    assert await w.rows(acct.sub) == before
    w.provider.fail_delete = False
    r = await w.api.call("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=fresh)
    assert r.status_code == 204
    assert all(v == [] for v in (await w.rows(acct.sub)).values())
    for t in ("sixkey.vaults", "sixkey.vault_versions", "sixkey.devices", "sixkey.enrollments"):
        assert await w.val(f"SELECT count(*) FROM {t}") == 0


async def test_deleted_account_other_devices_get_unknown_device(world):
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    await w.api.call(
        "DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=await w.login(acct.email)
    )
    assert code(await w.api.status(other)) == "unknown_device"
    # the old account session is still a valid JWT until exp, but the account is gone: init is refused
    assert code(await w.api.init(acct, sk.Dev(), sk.new_vault_keys(w.hour()))) == "session_invalid"
