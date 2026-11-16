"""Error responses: 500 / 503 by fault injection (nothing leaks, nothing changes), unknown routes,
and error bodies never echo the request."""

from __future__ import annotations

import asyncpg
import pytest

import sk


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


@pytest.fixture
def allow_5xx():
    sk.ALLOW_5XX["value"] = True
    yield
    sk.ALLOW_5XX["value"] = False


class Boom(Exception):
    pass


class PoolProxy:
    """asyncpg.Pool has __slots__; the app reads st.pool, so a proxy can stand in for it."""

    def __init__(self, pool, **over):
        self._pool, self._over = pool, over

    def __getattr__(self, name):
        return self._over.get(name) or getattr(self._pool, name)


async def test_driver_errors_become_500_without_details(world, allow_5xx, monkeypatch):
    w = world
    acct, dev, keys = await w.vault()
    real = w.pool.fetchrow

    async def broken(q, *a, **kw):
        if "FROM sixkey.vaults" in q:
            raise asyncpg.exceptions.CheckViolationError(
                "new row for relation violates check constraint; DETAIL: Failing row contains (secret-row-data)"
            )
        return await real(q, *a, **kw)

    monkeypatch.setattr(w.state, "pool", PoolProxy(w.pool, fetchrow=broken))
    r = await w.api.status(dev)
    assert (r.status_code, r.json()["error"]) == (500, {"code": "internal_error"})
    assert "secret-row-data" not in r.text and "Failing" not in r.text


async def test_unavailable_database_is_503_with_retry_after(world, allow_5xx, monkeypatch):
    w = world
    acct, dev, keys = await w.vault()

    async def down(*a, **kw):
        raise asyncpg.exceptions.CannotConnectNowError("the database system is starting up")

    monkeypatch.setattr(w.state, "pool", PoolProxy(w.pool, fetchrow=down))
    r = await w.api.status(dev)
    assert (r.status_code, code(r)) == (503, "unavailable") and r.headers["retry-after"] == "5"
    assert r.json()["error"]["retry_after"] == 5


async def test_unavailable_provider_is_503(world, allow_5xx):
    w = world
    w.provider.unavailable = True
    r = await w.api.call("POST", "/v1/auth/otp", {"email": sk.secret("p@example.invalid")})
    assert (r.status_code, code(r)) == (503, "unavailable")
    w.provider.unavailable = False


async def test_an_unexpected_exception_in_a_handler_is_500(world, allow_5xx, monkeypatch):
    from sixkey_server import retention

    w = world
    acct, dev, keys = await w.vault()

    async def explode(*a, **kw):
        raise Boom("internal detail that must not leak")

    monkeypatch.setattr("sixkey_server.routes.vault.prune", explode)
    r = await w.api.put_vault(dev, keys, 1)
    assert (r.status_code, code(r)) == (500, "internal_error") and "internal detail" not in r.text
    assert await w.val("SELECT version FROM sixkey.vaults") == 1  # the transaction rolled back
    assert retention.prune is not explode


async def test_unknown_routes_and_methods(world):
    w = world
    for method, path in (
        ("GET", "/v2/vault"),
        ("POST", "/v1/vault"),
        ("DELETE", "/v1/keys"),
        ("GET", "/"),
        ("PUT", "/v1/devices/fork"),
    ):
        r = await w.http.request(method, path)
        assert r.status_code == 404 and r.json()["error"] == {"code": "not_found"}, (method, path)
        assert isinstance(r.json()["server_time"], int)
    for path in ("/docs", "/openapi.json", "/redoc"):
        assert (await w.http.get(path)).status_code == 404


async def test_error_bodies_never_echo_the_request(world):
    w = world
    acct, dev, keys = await w.vault()
    marker = "zzMARKERzz"
    probes = [
        ("POST", "/v1/auth/otp", {"email": marker}),
        ("POST", "/v1/auth/otp", {"email": f"{marker}@example.invalid", marker: 1}),
        ("POST", "/v1/auth/verify", {"email": f"{marker}@example.invalid", "token": "123456"}),
        ("PUT", "/v1/keys", {"if_kver": 1, "bundle": marker, "password_auth": keys.pw_auth_b64}),
        (
            "PUT",
            "/v1/vault",
            {"if_version": 1, "envelope": marker, "write_proof": marker, "cursor": {"pending": marker}},
        ),
    ]
    for method, path, body in probes:
        r = await w.api.call(
            method, path, body, dev=dev if path.startswith("/v1/keys") or path == "/v1/vault" else None
        )
        assert r.status_code >= 400 and marker not in r.text, (path, r.text)
    r = await w.http.get(f"/v1/vault/versions/{marker}", headers={"Sixkey-Device": marker})
    assert marker not in r.text
