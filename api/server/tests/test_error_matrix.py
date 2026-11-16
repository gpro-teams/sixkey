"""The generic errors of §5.4 通用错误码, operation by operation: unknown_device, bad_signature,
clock_skew, device_revoked, session_invalid and rate_limited for every operation the contract lists
them for, plus the specific codes the other files do not reach."""

from __future__ import annotations

import copy
import dataclasses

import pytest

import sk
from sixkey_server.config import RateLimits

OPS = {op["operationId"]: (m.upper(), p, op) for p, item in sk.OPENAPI["paths"].items() for m, op in item.items()}
EXAMPLES = {}
for ex in sk.VECTORS["groups"]["wire_examples"]["examples"]:
    if ex["kind"] == "request" and ex.get("expect_valid", True):
        m, p = ex["operation"].split(" ", 1)
        EXAMPLES.setdefault(sk.OPENAPI["paths"][p][m.lower()]["operationId"], ex["body"])


def listed(oid, status, c):
    return c in OPS[oid][2]["x-sixkey-errors"].get(str(status), [])


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


@dataclasses.dataclass
class Sc:
    acct: sk.Acct
    dev: sk.Dev
    keys: sk.Keys
    other: sk.Dev
    revoked: sk.Dev
    flow: object


async def scenario(w) -> Sc:
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    revoked = await w.recovery_device(acct, keys)
    r = await w.api.call(
        "POST", f"/v1/devices/{revoked.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev
    )
    assert r.status_code == 200
    flow = await w.start_approval(acct)
    return Sc(acct, dev, keys, other, revoked, flow)


def path_for(oid, sc):
    return OPS[oid][1].replace("{id}", sc.other.device_id).replace("{rid}", sc.flow.rid).replace("{v}", "1")


def valid_body(oid, sc, *, wrong_proof=False, reg: sk.Dev | None = None):
    """A body that passes the operation's request schema (contents need not be meaningful)."""
    pw = sk.b64(sk.rnd(32)) if wrong_proof else sc.keys.pw_auth_b64
    b = copy.deepcopy(EXAMPLES.get(oid, {}))
    simple = {"rejectAllEnrollRequests", "revokeDevice", "deleteAccount", "rejectEnrollRequest", "deleteVaultVersions"}
    if oid in simple:
        b = {"password_auth": pw}
    elif oid == "completeEnrollRequest":
        b = {}
    if "password_auth" in b:
        b["password_auth"] = pw
    if reg is not None:
        if oid == "initVault":
            b["device"]["device_id"], b["device"]["sig_pubkey"] = reg.device_id, reg.spki_b64
        else:
            b["device_id"], b["sig_pubkey"] = reg.device_id, reg.spki_b64
    assert sk.SC.validate(sk.SC.request_schema(OPS[oid][2]), b, sk.OPENAPI) == [], oid
    return b


DEVICE_OPS = [o for o, (_, _, op) in OPS.items() if op["x-sixkey-auth"]["signer"] in ("device", "device_or_enroll")]
ENROLL_OPS = [o for o, (_, _, op) in OPS.items() if op["x-sixkey-auth"]["signer"] in ("enroll", "device_or_enroll")]


@pytest.mark.parametrize("oid", DEVICE_OPS)
async def test_generic_device_signature_errors(world, oid):
    w = world
    sc = await scenario(w)
    method, _, op = OPS[oid]
    path = path_for(oid, sc)
    acct = await w.login(sc.acct.email) if op["x-sixkey-auth"]["account_session"] != "none" else None
    raw = sk.compact(valid_body(oid, sc)).encode() if "requestBody" in op else None
    cases = {
        "unknown_device": dict(dev=sk.Dev()),
        "bad_signature": dict(dev=sc.dev, target=path + "x"),
        "clock_skew": dict(dev=sc.dev, ts=w.clock.now_ms() - 400_000),
        "device_revoked": dict(dev=sc.revoked),
    }
    for want, kw in cases.items():
        if not listed(oid, 401 if want != "device_revoked" else 403, want):
            continue
        r = await w.api.call(method, path, raw=raw, acct=acct, **kw)
        assert code(r) == want, (oid, want, r.text)


@pytest.mark.parametrize("oid", ENROLL_OPS)
async def test_generic_enroll_signature_errors(world, oid):
    w = world
    sc = await scenario(w)
    method, _, op = OPS[oid]
    path = path_for(oid, sc)
    raw = (
        sk.compact(valid_body(oid, sc) if oid != "rejectEnrollRequest" else {}).encode()
        if "requestBody" in op
        else None
    )
    enroll = (sc.flow.rid, sc.flow.dev)
    r = await w.api.call(method, path, raw=raw, enroll=enroll, target=path + "x")
    assert code(r) == "bad_signature"
    r = await w.api.call(method, path, raw=raw, enroll=enroll, ts=w.clock.now_ms() + 400_000)
    assert code(r) == "clock_skew"


ZERO = RateLimits(**{f.name: (0 if f.name == "otp_verify_code" else (0, 60)) for f in dataclasses.fields(RateLimits)})


@pytest.mark.parametrize("oid", [o for o in OPS if listed(o, 429, "rate_limited")])
async def test_every_operation_can_be_rate_limited(world, oid):
    w = world
    sc = await scenario(w)
    w.state.settings = dataclasses.replace(w.state.settings, limits=ZERO)
    method, _, op = OPS[oid]
    path = path_for(oid, sc)
    a = op["x-sixkey-auth"]
    kw: dict = {}
    if a["signer"] == "registration":
        reg = sk.Dev()
        kw = dict(acct=await _login_unlimited(w, sc.acct.email), reg=reg, body=valid_body(oid, sc, reg=reg))
    elif a["signer"] in ("device", "device_or_enroll"):
        kw = dict(dev=sc.dev, body=valid_body(oid, sc, wrong_proof=True) if "requestBody" in op else None)
        if a["account_session"] == "step_up":
            kw["acct"] = await _login_unlimited(w, sc.acct.email)
    elif a["signer"] == "enroll":
        kw = dict(enroll=(sc.flow.rid, sc.flow.dev), body=valid_body(oid, sc))
    elif a["account_session"] == "required":
        kw = dict(acct=await _login_unlimited(w, sc.acct.email))
    else:
        kw = dict(
            body={"email": "x@example.invalid"}
            if oid == "authOtp"
            else {"email": "x@example.invalid", "token": "123456"}
        )
    r = await w.api.call(method, path, **kw)
    assert code(r) == "rate_limited" and "retry-after" in r.headers, (oid, r.text)


async def _login_unlimited(w, email):
    limits = w.state.settings.limits
    w.state.settings = dataclasses.replace(
        w.state.settings,
        limits=RateLimits(
            otp_send_ip=(9999, 3600),
            otp_verify_ip=(9999, 3600),
            otp_send_email_ip=(9999, 600),
            otp_send_email_ip_day=(9999, 86400),
            otp_send_email_day=(9999, 86400),
        ),
    )
    acct = await w.login(email)
    w.state.settings = dataclasses.replace(w.state.settings, limits=limits)
    return acct


async def test_registration_bodies_that_fail_the_schema(world):
    w = world
    acct, dev, keys = await w.vault()
    s = await w.login(acct.email)
    d = sk.Dev()
    for path, body in (
        ("/v1/enroll/requests", {"device_id": d.device_id, "sig_pubkey": d.spki_b64, "commit": "short"}),
        (
            "/v1/enroll/recovery",
            {"device_id": d.device_id, "sig_pubkey": d.spki_b64, "recovery_auth": keys.rec_auth_b64, "extra": True},
        ),
        ("/v1/vault/init", {"vault_id": "x"}),
    ):
        r = await w.api.call("POST", path, body, acct=s, reg=d)
        assert code(r) == "invalid_request", path
    for path in ("/v1/enroll/requests", "/v1/enroll/recovery", "/v1/vault/init"):
        body = valid_body(
            {
                "/v1/enroll/requests": "createEnrollRequest",
                "/v1/enroll/recovery": "enrollWithRecovery",
                "/v1/vault/init": "initVault",
            }[path],
            Sc(acct, dev, keys, dev, dev, None),
            reg=d,
        )
        r = await w.api.call("POST", path, body, acct=s, reg=d, ts=w.clock.now_ms() - 301_000)
        assert code(r) == "clock_skew", path


async def test_init_vault_exists_and_idempotent_retry(world):
    w = world
    acct = await w.login()
    dev, keys = sk.Dev(), sk.new_vault_keys(w.hour())
    r1 = await w.api.init(acct, dev, keys)
    body = r1.request.content
    r2 = await w.api.call("POST", "/v1/vault/init", raw=body, acct=acct, reg=dev)  # same raw request, re-signed
    assert r1.status_code == r2.status_code == 201 and r2.json()["version"] == 1
    r3 = await w.api.init(acct, dev, keys)  # another bundle text
    assert code(r3) == "vault_exists"
    r4 = await w.api.init(acct, sk.Dev(), keys)
    assert code(r4) == "vault_exists"
    await w.api.put_vault(dev, keys, 1)
    r5 = await w.api.call("POST", "/v1/vault/init", raw=body, acct=acct, reg=dev)  # still the same bundle: 201
    assert r5.status_code == 201
    assert await w.val("SELECT version FROM sixkey.vaults") == 2  # and nothing was reset
    assert await w.val("SELECT count(*) FROM sixkey.devices") == 1


async def test_concurrent_inits_one_account(world):
    import asyncio

    w = world
    acct = await w.login()
    pairs = [(sk.Dev(), sk.new_vault_keys(w.hour())) for _ in range(5)]
    rs = await asyncio.gather(*(w.api.init(acct, d, k) for d, k in pairs))
    assert sorted(r.status_code for r in rs) == [201, 409, 409, 409, 409]
    assert {code(r) for r in rs if r.status_code == 409} == {"vault_exists"}
    assert await w.val("SELECT count(*) FROM sixkey.vaults") == 1
    assert await w.val("SELECT count(*) FROM sixkey.devices") == 1


async def test_concurrent_inits_same_device_id_two_accounts(world):
    import asyncio

    w = world
    a1, a2 = await w.login(), await w.login()
    d = sk.Dev()
    rs = await asyncio.gather(
        w.api.init(a1, d, sk.new_vault_keys(w.hour())), w.api.init(a2, d, sk.new_vault_keys(w.hour()))
    )
    assert sorted((r.status_code, code(r)) for r in rs) == [(201, None), (409, "device_exists")]
    assert await w.val("SELECT count(*) FROM sixkey.vaults") == 1  # the loser's vault insert rolled back
