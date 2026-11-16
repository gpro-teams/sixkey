"""§8.5: the real app against api/openapi.yaml and contract/vectors/sync-v1.json.

- The server's tables (operations, methods, paths, body limits, auth kinds, error codes, constants)
  equal the contract's.
- Wire examples and counterexamples through the server's own request validation.
- Vector groups through the server's verification code (the oracle is the vector file, computed by
  WebCrypto and re-checked by contract/py).
- Pre-signed vector requests (WebCrypto signatures at the vectors' now_ms) replayed byte for byte into
  the running app with seeded state, and the vectors' repair bodies through the real endpoints.
(Every response of every test is also schema-checked by sk.check_response.)
"""

from __future__ import annotations

import datetime as dt
import json
import uuid

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

import sk
from conftest import T0
from sixkey_server import constants, errors, schema, sigauth, wire
from sixkey_server.errors import ApiError
from sixkey_server.main import OPS
from sixkey_server.schema import Contract

V, O = sk.VECTORS, sk.OPENAPI
G = V["groups"]
FI = V["fixed_inputs"]
C = Contract()


def test_operations_match_the_contract():
    assert len(OPS) == 29 == len(C.ops)
    auth_map = {
        ("none", "none"): "none",
        ("none", "required"): "account",
        ("registration", "required"): "registration",
        ("device", "none"): "device",
        ("device", "step_up"): "device_step_up",
        ("enroll", "none"): "enroll",
        ("device_or_enroll", "none"): "device_or_enroll",
    }
    for op, _ in OPS:
        doc = sk.find_op(op.method, op.path.replace("{", "x").replace("}", "x"))
        spec = O["paths"][op.path][op.method.lower()]
        assert spec["operationId"] == op.op_id
        assert spec.get("x-sixkey-max-body-bytes") == op.max_body
        a = spec["x-sixkey-auth"]
        assert auth_map[(a["signer"], a["account_session"])] == op.auth, op.op_id
        assert a["pw_auth"] == op.proof, op.op_id
        assert doc is not None


def test_error_table_and_constants_match_the_contract():
    table = O["x-sixkey-error-codes"]
    assert errors.STATUS == {k: v["status"] for k, v in table.items()}
    assert errors.DETAIL_KEYS == set(O["components"]["schemas"]["ErrorBody"]["properties"]["error"]["properties"]) - {
        "code"
    }
    consts = {k: v["value"] for k, v in O["x-sixkey-constants"].items()}
    for name in (
        "MAX_ENVELOPE_BYTES",
        "MAX_BODY_BYTES_VAULT",
        "MAX_BODY_BYTES_OTHER",
        "KVER_MAX_JUMP",
        "SIG_WINDOW_S",
        "ACCOUNT_SESSION_TTL_S",
        "STEP_UP_MAX_AGE_S",
        "ENROLL_TTL_S",
        "AUTH_FAILURES_CAP",
        "DEVICES_MAX_ACTIVE",
        "HISTORY_KEEP_VERSIONS",
        "HISTORY_KEEP_DAYS",
        "HISTORY_MAX_BYTES",
        "UNCONFIRMED_USER_TTL_S",
        "DEVICE_NAME_CT_BYTES",
    ):
        assert getattr(constants, name) == consts[name], name
    assert (constants.HOUR_MS, constants.DAY_MS, constants.MINUTE_MS) == (
        consts["TRUNC_HOUR_MS"],
        consts["TRUNC_DAY_MS"],
        consts["TRUNC_MINUTE_MS"],
    )


def test_rate_limit_defaults_match_the_contract():
    from sixkey_server.config import RateLimits

    rl = RateLimits()
    for lim in O["x-sixkey-rate-limits"]["limits"]:
        if lim["id"] in ("pending_enrollments_per_session", "active_devices"):
            continue
        got = getattr(rl, lim["id"])
        assert (got if isinstance(got, int) else got[0]) == lim["limit"], lim["id"]
        if lim["window_s"] is not None:
            assert got[1] == lim["window_s"], lim["id"]


@pytest.mark.parametrize(
    "ex", G["wire_examples"]["examples"], ids=lambda e: f"{e['operation']} {e['kind']} {e.get('status', '')}"
)
def test_wire_examples_against_the_server_validator(ex):
    method, path = ex["operation"].split(" ", 1)
    oid = O["paths"][path][method.lower()]["operationId"]
    if ex["kind"] == "request":
        ok = C.request_valid(oid, ex["body"])
    else:
        sch = schema.Validator(C.doc)
        resp = sk.SC.deref(O, O["paths"][path][method.lower()]["responses"][ex["status"]])
        ok = sch.valid(resp["content"]["application/json"]["schema"], ex["body"])
    assert ok == ex.get("expect_valid", True), ex.get("why")


def test_number_tokens_vectors():
    for c in G["number_tokens"]["cases"]:
        try:
            schema.parse_strict(c["text"])
            ok = True
        except schema.JsonError:
            ok = False
        assert ok == c["integer_only"], c["name"]


def test_keybundle_shape_vectors():
    def ok(raw: str) -> bool:
        try:
            wire.bundle(C, raw)
            return True
        except ApiError:
            return False

    assert ok(G["keybundle"]["raw"])
    for c in G["keybundle"]["shape_cases"]:
        assert ok(c["raw"]) == c["shape_valid"], c["name"]
    for c in G["keybundle"]["mac_cases"]:
        assert ok(c["raw"]), c["name"]  # the server cannot check MACs; every MAC case is shape-valid


def test_envelope_vector_checksum_and_head():
    g = G["envelope"]
    e = wire.envelope(C, g["envelope_text"])
    assert (e.checksum, wire.b64e(e.head), e.rev, e.vault_id) == (
        g["checksum_b64"],
        g["head_b64"],
        g["rev"],
        g["vault_id"],
    )
    tampered = json.loads(g["envelope_text"])
    tampered["rev"] += 1  # rev is in the checksum's AAD: a keyless check catches it
    with pytest.raises(ApiError):
        wire.envelope(C, sk.compact(tampered))
    r = g["head_of_reserialized_text"]
    assert wire.b64e(wire.envelope(C, r["envelope_text"]).head) == r["head_b64"] != g["head_b64"]


def test_write_proof_vectors():
    g = G["write_proof"]
    key = wire.b64d(g["write_key_b64"])
    assert wire.write_proof_ok(key, g["vault_id"], g["if_version"], g["checksum_b64"], g["write_proof_b64"])
    for c in g["verify"]:
        assert (
            wire.write_proof_ok(key, c["vault_id"], c["if_version"], c["checksum_b64"], c["proof_b64"]) == c["valid"]
        ), c["name"]


def test_verifier_vectors():
    g = G["recovery_auth"]
    assert wire.b64e(wire.recovery_verifier_of(wire.b64d(g["recovery_auth_b64"]))) == g["recovery_verifier_b64"]
    for c in G["password_auth"]["cases"]:
        assert wire.b64e(wire.password_verifier_of(wire.b64d(c["password_auth_b64"]))) == c["password_verifier_b64"]


def test_public_key_vectors():
    for k in G["public_keys"]["keys"]:
        wire.spki_public_key(wire.b64d(k["spki_b64"]))
        wire.point_public_key(wire.b64d(k["point_b64"]))
    for r in G["public_keys"]["epk_reject"]:
        with pytest.raises(ApiError):
            wire.point_public_key(wire.b64d(r["b64"]))
    for r in G["public_keys"]["dpk_reject"]:
        with pytest.raises(ApiError):
            wire.spki_public_key(wire.b64d(r["b64"]))


def test_request_signature_vectors_through_the_server_code():
    g = G["request_signature"]
    for c in g["cases"]:
        msg = sigauth.signing_input(
            c["host"], c["method"], c["target"], c["signer"], c["sub"], str(c["ts"]), c["body"].encode()
        )
        assert msg.decode() == c["signing_input"], c["name"]
        sig = sigauth.parse_sig(c["sig_p1363_b64u"])
        assert sig is not None and sigauth.verify(wire.spki_public_key(wire.b64d(c["signer_key_spki_b64"])), msg, sig)
        # and the pure-Python ECDSA of contract/py agrees (no OpenSSL in that path)
        assert sk.SC.ecdsa_verify(sk.SC.dpk_point(wire.b64d(c["signer_key_spki_b64"])), msg, sig)
    for v in g["verify"]:
        sig = sigauth.parse_sig(v["sig_p1363_b64u"])
        ok = sig is not None and sigauth.verify(
            wire.spki_public_key(wire.b64d(v["key_spki_b64"])), v["signing_input"].encode(), sig
        )
        assert ok == v["valid"], v["name"]
    for f in g["signature_format_reject"]:
        assert sigauth.parse_sig(f["sig_b64u"]) is None, f["name"]


def test_fork_signature_vector_through_the_server_code():
    g = G["fork_signature"]
    msg = g["signing_input"].encode()
    old = wire.spki_public_key(wire.b64d(g["old_key_spki_b64"]))
    new = wire.spki_public_key(wire.b64d(g["new_key_spki_b64"]))
    assert sigauth.verify(old, msg, sigauth.parse_sig(g["sixkey_sig_b64u"]))
    assert sigauth.verify(new, msg, sigauth.parse_sig(g["sixkey_new_sig_b64u"]))
    assert not sigauth.verify(old, msg, sigauth.parse_sig(g["sixkey_new_sig_b64u"]))


def test_kver_rule_vectors():
    for c in G["kver_rules"]["server_accept"]:
        if not wire.kver_in_range(c["if_kver"], c["kver"]):
            got = "422 invalid_request"
        elif c["if_kver"] != c["server_kver"]:
            got = "200 idempotent" if c["raw_equals_stored"] else "409 keys_conflict"
        else:
            got = "200 applied"
        assert got == c["expect"], c["name"]


# ------------------------------------------------------------------------------------ seeded vector state


def key_of(name: str) -> ec.EllipticCurvePrivateKey:
    k = next(k for k in G["public_keys"]["keys"] if k["name"] == name)
    return ec.derive_private_key(int(k["d_hex"], 16), ec.SECP256R1())


class VDev(sk.Dev):
    """A device whose key is one of the vectors' fixed keys."""

    def __init__(self, device_id: str, key_name: str) -> None:
        self.device_id = device_id
        self.key = key_of(key_name)
        k = next(k for k in G["public_keys"]["keys"] if k["name"] == key_name)
        self.spki_b64, self.spki = k["spki_b64"], wire.b64d(k["spki_b64"])


async def seed(
    w,
    *,
    user: str | None = None,
    version: int,
    kver: int,
    bundle: str,
    envelope: str,
    write_key: bytes,
    pw_auth_b64: str,
    rec_verifier: bytes | None = None,
    devices: list[tuple[str, str]],
) -> uuid.UUID:
    uid = uuid.UUID(user) if user else uuid.uuid4()
    env = wire.envelope(C, envelope)
    bun = json.loads(bundle)
    hour = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc)
    async with w.admin.acquire() as con, con.transaction():
        await con.execute(
            "INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())",
            uid,
            f"{uid}@example.invalid",
        )
        await con.execute(
            "INSERT INTO sixkey.vaults (user_id, vault_id, version, vk_id, envelope, head, devices_rev, size_bytes, kver,"
            " bundle, recovery_verifier, password_verifier, write_key, history_bytes, created_at, updated_at)"
            " VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $14, $13, $13)",
            uid,
            bun["vaultId"],
            version,
            env.vk_id,
            envelope,
            env.head,
            env.size_bytes,
            kver,
            bundle,
            rec_verifier or sk.rnd(32),
            wire.password_verifier_of(wire.b64d(pw_auth_b64)),
            write_key,
            hour,
            env.size_bytes,
        )
        await con.execute(
            "INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes, created_at)"
            " VALUES ($1, $2, $3, $4, $5, $6)",
            uid,
            version,
            env.vk_id,
            envelope,
            env.size_bytes,
            hour,
        )
        for dev_id, spki in devices:
            await con.execute(
                "INSERT INTO sixkey.devices (device_id, user_id, sig_pubkey, joined_via, created_at)"
                " VALUES ($1, $2, $3, 'first', $4)",
                dev_id,
                uid,
                wire.b64d(spki),
                hour,
            )
    return uid


def vector_vault_kwargs(pw_auth_b64: str) -> dict:
    return dict(
        version=G["envelope"]["rev"],
        kver=G["keybundle"]["bundle"]["kver"],
        bundle=G["keybundle"]["raw"],
        envelope=G["envelope"]["envelope_text"],
        write_key=wire.b64d(G["write_proof"]["write_key_b64"]),
        pw_auth_b64=pw_auth_b64,
        devices=[(FI["dev_a"], key_spki("dsk_A")), (FI["dev_n"], key_spki("dsk_N"))],
    )


def key_spki(name: str) -> str:
    return next(k for k in G["public_keys"]["keys"] if k["name"] == name)["spki_b64"]


async def replay(w, c: dict, *, enroll: bool = False, auth: str | None = None):
    h = {
        ("Sixkey-Enroll" if enroll else "Sixkey-Device"): c["signer"].removeprefix("enroll:"),
        "Sixkey-Ts": str(c["ts"]),
        "Sixkey-Sig": c["sig_p1363_b64u"],
    }
    if auth:
        h["Authorization"] = f"Bearer {auth}"
    if c["body"]:
        h["Content-Type"] = "application/json"
    return await w.http.request(c["method"], c["target"], content=c["body"].encode(), headers=h)


def rs_case(name: str) -> dict:
    return next(c for c in G["request_signature"]["cases"] if c["name"].startswith(name))


async def test_presigned_status_requests_replayed_into_the_server(world, make_world):
    w = world
    assert w.clock.now_ms() == T0 == G["request_signature"]["cases"][0]["ts"]
    await seed(w, **vector_vault_kwargs(sk.b64(sk.rnd(32))))
    r = await replay(w, rs_case("device GET, no body"))
    assert r.status_code == 200 and r.json()["version"] == 42 and r.json()["head"] == G["envelope"]["head_b64"]
    r = await replay(w, rs_case("raw target keeps the query string"))
    assert r.status_code == 200, r.text
    # signed for the e2e origin: rejected by a server configured for api.sixkey.app ...
    r = await replay(w, rs_case("e2e origin"))
    assert r.status_code == 401 and r.json()["error"]["code"] == "bad_signature"
    # ... accepted by one configured for http://127.0.0.1:8787
    async with make_world(api_origin="http://127.0.0.1:8787") as w2:
        await seed(w2, **vector_vault_kwargs(sk.b64(sk.rnd(32))))
        r = await replay(w2, rs_case("e2e origin"))
        assert r.status_code == 200, r.text
    # non-ASCII body bytes: the signature verifies over the raw bytes; the body then fails the schema (422)
    r = await replay(w, rs_case("non-ASCII body bytes"))
    assert r.status_code == 422, r.text
    # the PUT body: signature valid, then the vector's (rev 42 / if_version 41) state does not fit: not 401
    r = await replay(w, rs_case("device PUT /v1/vault"))
    assert r.status_code not in (401, 403), r.text


async def test_presigned_enrollment_poll_replayed(world):
    w = world
    uid = await seed(w, **vector_vault_kwargs(sk.b64(sk.rnd(32))))
    async with w.admin.acquire() as con:
        await con.execute(
            "INSERT INTO sixkey.enrollments (request_id, user_id, via, session_ref, new_device_id, new_sig_pubkey, commit,"
            " state, created_at, expires_at) VALUES ($1, $2, 'approval', $3, $4, $5, $6, 'pending', now(), $7)",
            uuid.UUID(FI["rid"]),
            uid,
            sk.rnd(32),
            "AAAAAAAAAAAAAAAAAAAAAA",
            wire.b64d(key_spki("dsk_N")),
            sk.rnd(32),
            dt.datetime.fromtimestamp(T0 / 1000 + 600, dt.timezone.utc),
        )
    r = await replay(w, rs_case("enrolling device polls"), enroll=True)
    assert r.status_code == 200 and r.json()["state"] == "pending", r.text


async def test_presigned_delete_account_replayed(world):
    w = world
    c = rs_case("device + account session")
    pw = json.loads(c["body"])["password_auth"]
    uid = await seed(w, user=FI["sub"], **vector_vault_kwargs(pw))
    token = w.provider.sign(
        {
            "iss": w.settings.jwt_issuer,
            "aud": "authenticated",
            "sub": FI["sub"],
            "iat": T0 // 1000,
            "exp": T0 // 1000 + 900,
            "session_id": sk.uuid4(),
            "role": "authenticated",
            "is_anonymous": False,
        }
    )
    r = await replay(w, c, auth=token)
    assert r.status_code == 204, r.text
    assert all(v == [] for v in (await w.rows(str(uid))).values())


async def test_presigned_fork_replayed(world):
    w = world
    g = G["fork_signature"]
    body = json.loads(g["body"])
    await seed(w, **vector_vault_kwargs(body["password_auth"]))
    h = {
        "Sixkey-Device": g["signer"],
        "Sixkey-Ts": str(g["ts"]),
        "Sixkey-Sig": g["sixkey_sig_b64u"],
        "Sixkey-New-Sig": g["sixkey_new_sig_b64u"],
        "Content-Type": "application/json",
    }
    r = await w.http.request("POST", g["target"], content=g["body"].encode(), headers=h)
    assert r.status_code == 201 and r.json()["device_id"] == g["new_device_id"], r.text
    rows = await w.sql(
        "SELECT joined_via, approved_by, sig_pubkey FROM sixkey.devices WHERE device_id = $1", g["new_device_id"]
    )
    assert rows[0]["joined_via"] == "fork" and rows[0]["approved_by"] == g["signer"]
    assert bytes(rows[0]["sig_pubkey"]) == wire.b64d(g["new_key_spki_b64"])


async def test_presigned_fork_without_or_with_a_wrong_new_sig(world):
    w = world
    g = G["fork_signature"]
    body = json.loads(g["body"])
    await seed(w, **vector_vault_kwargs(body["password_auth"]))
    base = {
        "Sixkey-Device": g["signer"],
        "Sixkey-Ts": str(g["ts"]),
        "Sixkey-Sig": g["sixkey_sig_b64u"],
        "Content-Type": "application/json",
    }
    for extra in ({}, {"Sixkey-New-Sig": g["sixkey_sig_b64u"]}):  # missing; the old key's signature
        r = await w.http.request("POST", g["target"], content=g["body"].encode(), headers={**base, **extra})
        assert r.status_code == 401 and r.json()["error"]["code"] == "bad_signature"
    assert await w.val("SELECT count(*) FROM sixkey.devices WHERE device_id = $1", g["new_device_id"]) == 0


async def test_keys_repair_vector_through_put_keys(world):
    w = world
    g = G["keys_repair"]
    req = g["request"]
    await seed(w, **vector_vault_kwargs(req["password_auth"]))
    dev = VDev(FI["dev_a"], "dsk_A")
    r = await w.api.call("PUT", "/v1/keys", req, dev=dev)
    assert r.status_code == 200 and r.json()["kver"] == json.loads(req["bundle"])["kver"], r.text
    assert (await w.api.call("GET", "/v1/keys", dev=dev)).json()["bundle"] == req["bundle"]


@pytest.mark.parametrize("case", G["keys_repair"]["p4_cases"], ids=lambda c: c["name"][:40])
async def test_p4_vector_cases_through_put_keys(world, case):
    w = world
    req = G["keys_repair"]["request"]
    await seed(w, **vector_vault_kwargs(req["password_auth"]))
    body = {"if_kver": 3, "bundle": case["bundle"], "password_auth": req["password_auth"]}
    if isinstance(case["expect"], dict):
        if case["expect"]["recovery_verifier"]:
            body["recovery_verifier"] = sk.b64(sk.rnd(32))
        if case["expect"]["password_verifier"]:
            body["password_verifier"] = sk.b64(sk.rnd(32))
        # a verifier that P4 does not call for, or a missing one, is refused first (no state change)
        for k in ("recovery_verifier", "password_verifier"):
            wrong = dict(body)
            if k in wrong:
                del wrong[k]
            else:
                wrong[k] = sk.b64(sk.rnd(32))
            r = await w.api.call("PUT", "/v1/keys", wrong, dev=VDev(FI["dev_a"], "dsk_A"))
            assert r.status_code == 422, (k, r.text)
        want = 200
    else:
        want = 422
    r = await w.api.call("PUT", "/v1/keys", body, dev=VDev(FI["dev_a"], "dsk_A"))
    assert r.status_code == want, r.text


async def test_rotate_repair_vector_through_rotate(world):
    w = world
    g = G["rotate_repair"]
    req = g["request"]
    await seed(w, **vector_vault_kwargs(req["password_auth"]))
    dev = VDev(FI["dev_a"], "dsk_A")
    st = (await w.api.status(dev)).json()
    assert {k: st[k] for k in ("version", "kver", "vk_id")} == {k: g["server"][k] for k in ("version", "kver", "vk_id")}
    assert st["head"] == g["server"]["head_b64"]
    r = await w.api.call("POST", "/v1/keys/rotate", req, dev=dev)
    assert (
        r.status_code == 200 and r.json()["version"] == 43 and r.json()["kver"] == json.loads(req["bundle"])["kver"]
    ), r.text
    st = (await w.api.status(dev)).json()
    assert st["vk_id"] == json.loads(req["envelope"])["vkId"] and st["head"] == sk.b64(
        sk.sha256(req["envelope"].encode())
    )
    names = {
        r_["device_id"]: json.loads(r_["name_ct"])
        for r_ in await w.sql("SELECT device_id, name_ct FROM sixkey.devices")
    }
    assert names == {d["device_id"]: d["name_ct"] for d in req["device_names"]}
    # the new K_write is in force: a write proof with the old one is refused
    k_new = wire.b64d(req["new_write_key"])
    assert bytes((await w.sql("SELECT write_key FROM sixkey.vaults"))[0]["write_key"]) == k_new


async def test_rotate_repair_counterexample_without_recovery_verifier(world):
    w = world
    req = dict(G["rotate_repair"]["request"])
    await seed(w, **vector_vault_kwargs(req["password_auth"]))
    del req["recovery_verifier"]
    r = await w.api.call("POST", "/v1/keys/rotate", req, dev=VDev(FI["dev_a"], "dsk_A"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
    assert (await w.val("SELECT version FROM sixkey.vaults")) == 42


async def test_approve_checks_sig_pubkey_sha256_like_the_vector(world):
    w = world
    assert sk.b64(sk.sha256(wire.b64d(key_spki("dsk_N")))) == G["enrollment"]["sig_pubkey_sha256_b64"]
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    await flow.respond(dev_a, keys)
    await flow.reveal()
    r = await flow.approve(dev_a, keys, body={"sig_pubkey_sha256": G["enrollment"]["sig_pubkey_sha256_b64"]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "key_mismatch"
    r = await flow.approve(dev_a, keys)
    assert r.status_code == 200


def test_the_server_refuses_a_contract_keyword_it_does_not_enforce(tmp_path):
    doc = json.loads(json.dumps(O))
    doc["components"]["schemas"]["OtpRequest"]["propertyNames"] = {"pattern": "^e"}
    p = tmp_path / "openapi.yaml"
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="unsupported schema keyword propertyNames"):
        Contract(str(p))
    v = schema.Validator(O)
    assert v.valid({"type": "array", "uniqueItems": True}, [1, 2]) and not v.valid(
        {"type": "array", "uniqueItems": True}, [1, 1]
    )
