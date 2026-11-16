"""§5.2 request signatures and the account session, adversarially (§8.4 "签名" and "JWT").

Signature order (P6): look up the device, verify, then revoked, then the ±300 s window.
Replays inside the window are handled by CAS, idempotency and one-shot state machines (no nonce
cache, x-sixkey-signature.no_nonce_cache); each kind is checked here.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

import sk
from conftest import T0
from sixkey_server.sigauth import P256_N


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


async def test_valid_request_and_each_tampered_field(world):
    w = world
    acct, dev, keys = await w.vault()
    assert (await w.api.status(dev)).status_code == 200
    other = sk.Dev()
    cases = {
        "wrong key": dict(signer=None, key=other),
        "other target": dict(target="/v1/keys"),
        "other host": dict(host="evil.example"),
        "other method": dict(method="POST"),
        "sub added": dict(sub="00000000-0000-4000-8000-0000000000aa"),
        "other ts in the input": dict(ts_in_input=T0 + 1),
    }
    for name, c in cases.items():
        key = c.get("key", dev)
        msg = sk.signing_input(
            c.get("method", "GET"),
            c.get("target", "/v1/sync/status"),
            dev.device_id,
            c.get("sub", "-"),
            c.get("ts_in_input", T0),
            b"",
            c.get("host", sk.HOST),
        )
        r = await w.http.get(
            "/v1/sync/status",
            headers={"Sixkey-Device": dev.device_id, "Sixkey-Ts": str(T0), "Sixkey-Sig": key.sign(msg)},
        )
        assert (r.status_code, code(r)) == (401, "bad_signature"), name


async def test_tampered_body_and_dropped_delete_body(world):
    w = world
    acct, dev, keys = await w.vault()
    body = sk.compact({"password_auth": keys.pw_auth_b64}).encode()
    ts = w.clock.now_ms()
    sig = dev.sign(sk.signing_input("DELETE", "/v1/vault/versions", dev.device_id, "-", ts, body))
    h = {"Sixkey-Device": dev.device_id, "Sixkey-Ts": str(ts), "Sixkey-Sig": sig, "Content-Type": "application/json"}
    tampered = body.replace(b'{"password_auth"', b'{ "password_auth"')  # same JSON, other bytes
    r = await w.http.request("DELETE", "/v1/vault/versions", content=tampered, headers=h)
    assert code(r) == "bad_signature"
    # N25: a proxy that drops a DELETE body makes the body hash wrong: fail closed
    r = await w.http.request("DELETE", "/v1/vault/versions", content=b"", headers=h)
    assert code(r) == "bad_signature"
    r = await w.http.request("DELETE", "/v1/vault/versions", content=body, headers=h)
    assert r.status_code == 200


async def test_host_header_is_ignored_and_target_is_raw(world):
    w = world
    acct, dev, keys = await w.vault()
    # the Host header a proxy would forward is not part of the check (the configured host is)
    r = await w.api.status(dev, headers={"Host": "attacker.example"})
    assert r.status_code == 200
    # query string and percent-encoding verbatim
    r = await w.api.call("GET", "/v1/sync/status?b=2&a=%7C", dev=dev)
    assert r.status_code == 200
    r = await w.api.call("GET", "/v1/sync/status?b=2&a=%7C", dev=dev, target="/v1/sync/status")
    assert code(r) == "bad_signature"
    r = await w.api.call("GET", "/v1/sync/status?b=2&a=%7C", dev=dev, target="/v1/sync/status?a=%7C&b=2")
    assert code(r) == "bad_signature"


async def test_target_with_a_pipe_is_refused(world):
    """'|' would let fields of the signing input shift; the server refuses such a target (§2.2)."""
    w = world
    acct, dev, keys = await w.vault()
    target = "/v1/sync/status?x=a|b"
    msg = sk.signing_input("GET", target, dev.device_id, "-", T0, b"")
    scope_headers = [
        (b"sixkey-device", dev.device_id.encode()),
        (b"sixkey-ts", str(T0).encode()),
        (b"sixkey-sig", dev.sign(msg).encode()),
        (b"host", b"api.sixkey.app"),
    ]
    sent = {}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(m):
        if m["type"] == "http.response.start":
            sent["status"] = m["status"]
        elif m["type"] == "http.response.body":
            sent["body"] = sent.get("body", b"") + m.get("body", b"")

    await w.app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": "/v1/sync/status",
            "raw_path": b"/v1/sync/status",
            "query_string": b"x=a|b",
            "headers": scope_headers,
            "client": ("203.0.113.7", 1),
            "server": ("api.sixkey.app", 443),
            "root_path": "",
        },
        receive,
        send,
    )
    assert sent["status"] == 401 and b"bad_signature" in sent["body"]


@pytest.mark.parametrize("delta,status", [(0, 200), (300_000, 200), (-300_000, 200), (300_001, 401), (-300_001, 401)])
async def test_timestamp_window_edges(world, delta, status):
    w = world
    acct, dev, keys = await w.vault()
    r = await w.api.status(dev, ts=T0 + delta)
    assert r.status_code == status
    if status == 401:
        assert code(r) == "clock_skew" and r.json()["server_time"] == T0


@pytest.mark.parametrize(
    "bad",
    [
        "missing ts",
        "ts with letters",
        "ts too long",
        "missing sig",
        "der",
        "63 bytes",
        "r = 0",
        "s = n",
        "padded b64url",
        "missing device",
        "short device id",
    ],
)
async def test_malformed_signature_headers(world, bad):
    w = world
    acct, dev, keys = await w.vault()
    msg = sk.signing_input("GET", "/v1/sync/status", dev.device_id, "-", T0, b"")
    good = dev.sign_p1363(msg)
    h = {"Sixkey-Device": dev.device_id, "Sixkey-Ts": str(T0), "Sixkey-Sig": sk.b64u(good)}
    if bad == "missing ts":
        del h["Sixkey-Ts"]
    elif bad == "ts with letters":
        h["Sixkey-Ts"] = "17920515947a7"
    elif bad == "ts too long":
        h["Sixkey-Ts"] = "1" * 17
    elif bad == "missing sig":
        del h["Sixkey-Sig"]
    elif bad == "der":
        der = dev.key.sign(msg, ec.ECDSA(hashes.SHA256()))
        h["Sixkey-Sig"] = sk.b64u(der)
    elif bad == "63 bytes":
        h["Sixkey-Sig"] = sk.b64u(good[:63])
    elif bad == "r = 0":
        h["Sixkey-Sig"] = sk.b64u(bytes(32) + good[32:])
    elif bad == "s = n":
        h["Sixkey-Sig"] = sk.b64u(good[:32] + P256_N.to_bytes(32, "big"))
    elif bad == "padded b64url":
        h["Sixkey-Sig"] = base64.urlsafe_b64encode(good).decode()
    elif bad == "missing device":
        del h["Sixkey-Device"]
    elif bad == "short device id":
        h["Sixkey-Device"] = dev.device_id[:21]
    r = await w.http.get("/v1/sync/status", headers=h)
    assert (r.status_code, code(r)) == (401, "bad_signature")


async def test_p1363_with_high_s_is_accepted(world):
    """WebCrypto does not normalize s; (r, n - s) is the same signature and must verify."""
    w = world
    acct, dev, keys = await w.vault()
    msg = sk.signing_input("GET", "/v1/sync/status", dev.device_id, "-", T0, b"")
    sig = dev.sign_p1363(msg)
    s = int.from_bytes(sig[32:], "big")
    flipped = sig[:32] + (P256_N - s).to_bytes(32, "big")
    for v in (sig, flipped):
        r = await w.http.get(
            "/v1/sync/status", headers={"Sixkey-Device": dev.device_id, "Sixkey-Ts": str(T0), "Sixkey-Sig": sk.b64u(v)}
        )
        assert r.status_code == 200


async def test_unknown_revoked_and_foreign_devices(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    acct2, dev_x, keys2 = await w.vault()
    r = await w.api.status(sk.Dev())
    assert (r.status_code, code(r)) == (401, "unknown_device")
    # someone else's device id with my key: the signature does not verify against that device's key
    r = await w.api.call(
        "GET", "/v1/sync/status", dev=dev_a, signer=dev_x.device_id, headers={"Sixkey-Device": dev_x.device_id}
    )
    assert code(r) == "bad_signature"
    await w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    r = await w.api.status(dev_b)
    assert (r.status_code, code(r)) == (403, "device_revoked")
    # P6: a revoked device with a bad signature learns nothing about the revocation
    r = await w.api.status(dev_b, ts=T0, target="/v1/keys")
    assert (r.status_code, code(r)) == (401, "bad_signature")
    # and a revoked device outside the window: verified, then revoked comes before the window
    r = await w.api.status(dev_b, ts=T0 - 600_000)
    assert code(r) == "device_revoked"


async def test_registration_signature_rules(world):
    w = world
    acct = await w.login()
    dev, keys = sk.Dev(), sk.new_vault_keys(w.hour())
    other = sk.Dev()
    # Sixkey-Device must equal the body's device_id
    r = await w.api.init(
        acct, dev, keys, device={"device_id": other.device_id, "sig_pubkey": dev.spki_b64, "name_ct": keys.name_ct()}
    )
    assert code(r) == "bad_signature"
    # signed by a key other than the body's sig_pubkey
    body_dev = {"device_id": dev.device_id, "sig_pubkey": other.spki_b64, "name_ct": keys.name_ct()}
    r = await w.api.init(acct, dev, keys, device=body_dev)
    assert code(r) == "bad_signature"
    # the sub in the signing input is the JWT sub
    r = await w.api.call(
        "POST",
        "/v1/enroll/requests",
        {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "commit": sk.b64(sk.rnd(32))},
        acct=acct,
        reg=dev,
        sub="-",
    )
    assert code(r) == "bad_signature"
    # an off-curve key in the body is a malformed body
    k = sk.VECTORS["groups"]["public_keys"]["dpk_reject"][-1]["b64"]
    r = await w.api.init(
        acct, dev, keys, device={"device_id": dev.device_id, "sig_pubkey": k, "name_ct": keys.name_ct()}
    )
    assert (r.status_code, code(r)) == (422, "invalid_request")
    assert await w.val("SELECT count(*) FROM sixkey.vaults") == 0
    r = await w.api.init(acct, dev, keys)
    assert r.status_code == 201


async def test_enroll_signer_must_match_the_path(world):
    w = world
    acct, dev_a, keys = await w.vault()
    f1 = await w.start_approval(acct)
    f2 = await w.start_approval(acct)
    r = await w.api.call("GET", f"/v1/enroll/requests/{f2.rid}", enroll=(f1.rid, f1.dev))
    assert code(r) == "bad_signature"
    r = await w.api.call("GET", f"/v1/enroll/requests/{f1.rid}", enroll=(f1.rid, f2.dev))
    assert code(r) == "bad_signature"
    r = await w.api.call(
        "GET", f"/v1/enroll/requests/{f1.rid}", enroll=(f1.rid, f1.dev), headers={"Sixkey-Device": dev_a.device_id}
    )
    assert code(r) == "bad_signature"  # both signer headers at once


async def test_replays_inside_the_window_are_harmless(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)

    async def twice(method, path, body, **kw):
        raw = sk.compact(body).encode()
        r1 = await w.api.call(method, path, raw=raw, **kw)
        r2 = await w.http.request(method, path, content=raw, headers=dict(r1.request.headers))
        return r1, r2

    r1, r2 = await twice(
        "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r1.status_code == r2.status_code == 200 and r1.json()["revoked_at"] == r2.json()["revoked_at"]
    rev = await w.val("SELECT devices_rev FROM sixkey.vaults")
    flow = await w.start_approval(acct)
    r1, r2 = await twice(
        "POST", f"/v1/enroll/requests/{flow.rid}/reject", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r1.status_code == 200 and code(r2) == "enroll_gone"
    _, body = (
        lambda k: (
            None,
            {
                "if_kver": 1,
                "bundle": k.bundle(dev_a.device_id, kver=2),
                "password_auth": k.pw_auth_b64,
                "recovery_verifier": k.rec_verifier(sk.rnd(32)),
            },
        )
    )(_rec(keys))
    r1, r2 = await twice("PUT", "/v1/keys", body, dev=dev_a)
    assert r1.status_code == r2.status_code == 200
    assert await w.val("SELECT kver FROM sixkey.vaults") == 2
    assert await w.val("SELECT devices_rev FROM sixkey.vaults") == rev
    # outside the window a captured request is dead
    w.clock.advance(300_001)
    r = await w.http.request("PUT", "/v1/keys", content=r1.request.content, headers=dict(r1.request.headers))
    assert code(r) == "clock_skew"


def _rec(keys):
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    return keys


# ------------------------------------------------------------------------------------ account session


def claims(w, acct, **over):
    c = {
        "iss": w.settings.jwt_issuer,
        "aud": "authenticated",
        "sub": acct.sub,
        "iat": T0 // 1000,
        "exp": T0 // 1000 + 900,
        "session_id": sk.uuid4(),
        "role": "authenticated",
        "is_anonymous": False,
    }
    c.update(over)
    return {k: v for k, v in c.items() if v is not None}


async def account_status(w, token):
    return await w.http.get("/v1/account", headers={"Authorization": f"Bearer {token}"})


async def test_account_session_checks(world):
    import jwt

    w = world
    acct = await w.login()
    assert (await account_status(w, acct.token)).status_code == 200
    bad = {
        "expired": w.provider.sign(claims(w, acct, exp=T0 // 1000)),
        "aud": w.provider.sign(claims(w, acct, aud="anon")),
        "iss": w.provider.sign(claims(w, acct, iss="https://evil.example/auth/v1")),
        "anonymous": w.provider.sign(claims(w, acct, is_anonymous=True)),
        "no sub": w.provider.sign(claims(w, acct, sub=None)),
        "sub not a uuid": w.provider.sign(claims(w, acct, sub="admin")),
        "no session_id": w.provider.sign(claims(w, acct, session_id=None)),
        "iat in the future": w.provider.sign(claims(w, acct, iat=T0 // 1000 + 3600, exp=T0 // 1000 + 4000)),
        "role anon": w.provider.sign(claims(w, acct, role="anon")),
        "unknown kid": w.provider.sign(claims(w, acct), kid="other"),
        "other key, same kid": w.provider.sign(claims(w, acct), key=ec.generate_private_key(ec.SECP256R1())),
        "alg none": jwt.encode(claims(w, acct), None, algorithm="none", headers={"kid": w.provider.kid}),
        "garbage": "not.a.jwt",
        "empty": "",
    }
    # HS256 with the public key as the HMAC secret (key confusion)
    pub = w.provider.jwt_keys()[w.provider.kid].public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    import hmac as _h, hashlib as _hl, json as _j

    head = sk.b64u(_j.dumps({"alg": "HS256", "typ": "JWT", "kid": w.provider.kid}).encode())
    body = sk.b64u(_j.dumps(claims(w, acct)).encode())
    bad["hs256 confusion"] = f"{head}.{body}." + sk.b64u(_h.new(pub, f"{head}.{body}".encode(), _hl.sha256).digest())
    for name, tok in bad.items():
        r = await account_status(w, tok)
        assert (r.status_code, code(r)) == (401, "session_invalid"), name
    r = await w.http.get("/v1/account")
    assert code(r) == "session_invalid"
    r = await w.http.get("/v1/account", headers={"Authorization": "Basic abc"})
    assert code(r) == "session_invalid"


async def test_session_token_expires_after_900_seconds(world):
    w = world
    acct = await w.login()
    w.clock.advance(899_000)
    assert (await account_status(w, acct.token)).status_code == 200
    w.clock.advance(1_000)
    assert code(await account_status(w, acct.token)) == "session_invalid"


async def test_verify_revokes_the_session_at_once(world):
    """§5.2 C1: only the access token leaves the server; the refresh token is dead immediately."""
    w = world
    email = sk.secret("rv@example.invalid")
    await w.api.call("POST", "/v1/auth/otp", {"email": email})
    code_ = w.provider.last_code(email)
    sessions_before = set(w.provider._sessions)
    r = await w.api.call("POST", "/v1/auth/verify", {"email": email, "token": code_})
    assert set(r.json()) == {"account_token", "expires_at", "server_time"}
    new = [s for k, s in w.provider._sessions.items() if k not in sessions_before]
    assert len(new) == 1 and new[0].revoked and not w.provider.refresh(new[0].refresh_token)
    assert r.json()["expires_at"] == (T0 // 1000 + 900) * 1000


async def test_step_up_for_account_deletion(world):
    w = world
    acct, dev, keys = await w.vault()
    acct2 = await w.login()
    old = await w.login(acct.email)
    w.clock.advance(601_000)
    fresh = await w.login(acct.email)
    body = {"password_auth": keys.pw_auth_b64}
    r = await w.api.call("DELETE", "/v1/account", body, dev=dev, acct=old)  # iat older than 600 s
    assert code(r) == "step_up_required"
    r = await w.api.call("DELETE", "/v1/account", body, dev=dev, acct=acct2)  # another account's session
    assert code(r) == "step_up_required"
    r = await w.api.call("DELETE", "/v1/account", body, dev=dev)  # no session at all
    assert code(r) == "session_invalid"
    assert await w.val("SELECT count(*) FROM sixkey.vaults") == 1
    r = await w.api.call("DELETE", "/v1/account", body, dev=dev, acct=fresh)
    assert r.status_code == 204
