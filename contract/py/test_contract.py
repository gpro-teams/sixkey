"""M0 contract checks, Python side.

    python3 -I contract/py/test_contract.py      (plain runner, no third-party packages needed)
    python3 -m pytest contract/py                (also works when pytest is installed)

Loads the same files the TypeScript test loads: contract/vectors/sync-v1.json, its JSON Schema, and
api/openapi.yaml. AES-GCM checks need pyca/cryptography; without it they are reported as skipped, never as passed.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # leave no __pycache__ in the repo
# `python3 -I` does not put this directory on sys.path, so load the sibling module by file location.
_spec = importlib.util.spec_from_file_location("sixkey_contract", os.path.join(_HERE, "sixkey_contract.py"))
assert _spec and _spec.loader
sc = importlib.util.module_from_spec(_spec)
sys.modules["sixkey_contract"] = sc
_spec.loader.exec_module(sc)

VECTORS, VECTOR_SCHEMA, OPENAPI = sc.load_all()
REPORT: dict[str, dict] = {}


def test_vector_schema_uses_only_the_supported_subset() -> None:
    sc.lint_schema(VECTOR_SCHEMA, "sync-v1.schema.json")


def test_vectors_validate_against_their_schema() -> None:
    errs = sc.validate(VECTOR_SCHEMA, VECTORS, VECTOR_SCHEMA)
    assert not errs, "\n".join(errs[:20])


def test_schema_validator_rejects_a_broken_vector_file() -> None:
    broken = dict(VECTORS, groups=dict(VECTORS["groups"]))
    del broken["groups"]["enrollment"]
    assert sc.validate(VECTOR_SCHEMA, broken, VECTOR_SCHEMA), "a missing group must be reported"
    broken2 = dict(VECTORS, v=2)
    assert sc.validate(VECTOR_SCHEMA, broken2, VECTOR_SCHEMA), "a wrong version must be reported"


def test_every_group_has_a_python_verifier() -> None:
    assert set(VECTORS["groups"]) == set(sc.VERIFIERS), sorted(set(VECTORS["groups"]) ^ set(sc.VERIFIERS))


def _group_test(name: str):
    def t() -> None:
        g = VECTORS["groups"][name]
        res = sc.VERIFIERS[name](g, VECTORS)
        claimed = set(g["verified_by"])
        if "python-cryptography" in claimed:
            assert res["python-cryptography"] in ("ok",) or res["python-cryptography"].startswith("skipped"), res
        else:
            assert res["python-cryptography"] == "n/a", f"{name}: verified with cryptography but not tagged"
        assert "python-stdlib" in claimed, f"{name}: the Python stdlib verifier ran but the group does not list it"
        REPORT[name] = res

    t.__name__ = f"test_vectors_{name}"
    return t


for _name in sc.VERIFIERS:
    globals()[f"test_vectors_{_name}"] = _group_test(_name)


def test_openapi_parses_refs_resolve_and_error_codes_exist() -> None:
    errs = sc.check_openapi(OPENAPI)
    assert not errs, "\n".join(errs)


def test_openapi_checker_catches_mistakes() -> None:
    import copy

    bad = copy.deepcopy(OPENAPI)
    bad["paths"]["/v1/vault"]["put"]["x-sixkey-errors"]["409"].append("no_such_code")
    bad["paths"]["/v1/keys"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] = (
        "#/components/schemas/Nope"
    )
    bad["paths"]["/v1/time"] = {"get": dict(OPENAPI["paths"]["/healthz"]["get"], operationId="time")}
    bad["components"]["schemas"]["ErrorCode"]["enum"].append("sensitive_locked")
    # revision 5 regressions: conditional GET, devices_changed_at, new_sig in the fork body
    get_vault = bad["paths"]["/v1/vault"]["get"]
    get_vault["parameters"].append(
        {"name": "If-None-Match", "in": "header", "required": False, "schema": {"type": "string"}}
    )
    get_vault["responses"]["304"] = {"description": "not modified"}
    get_vault["responses"]["200"]["headers"] = {"ETag": {"schema": {"type": "string"}}}
    status = bad["components"]["schemas"]["StatusResponse"]["properties"]
    status["devices_changed_at"] = status.pop("devices_rev")
    fork = bad["paths"]["/v1/devices/fork"]["post"]
    fork["parameters"] = [p for p in fork["parameters"] if p.get("$ref") != "#/components/parameters/SixkeyNewSig"]
    bad["components"]["schemas"]["ForkRequest"]["properties"]["new_sig"] = {"type": "string"}
    errs = "\n".join(sc.check_openapi(bad))
    for needle in (
        "no_such_code",
        "Nope",
        "/v1/time",
        "sensitive_locked",
        "If-None-Match",
        "removed status 304",
        "removed header ETag",
        "devices_changed_at",
        "Sixkey-New-Sig",
        "new_sig must not",
    ):
        assert needle in errs, f"checker missed {needle}: {errs}"


def test_vectors_agree_with_the_contract() -> None:
    errs = sc.cross_file_errors(VECTORS, OPENAPI)
    assert not errs, "\n".join(errs)


# ---- revision 15 (§0.0o, the M4 backend review)

# The same table as extension/test/unit/contract-openapi.test.ts. "\\u0000" puts the escape into the JSON text;
# the two "raw" cases put a lone surrogate code point into the text itself.
STRICT_CASES = [
    ("objects, arrays and literals", '{"a":1,"b":[1,2,{"c":null}],"d":true,"e":false}', True),
    (
        "an escaped surrogate pair and other escapes",
        '{"s":"\\ud83d\\ude00 \\u00e9 \\" \\\\ \\/ \\b\\f\\n\\r\\t"}',
        True,
    ),
    ("the safe-integer bounds and zero", '{"m":9007199254740991,"n":-9007199254740991,"z":0}', True),
    ("whitespace around the value", ' \t\n\r{"a":[ 1 , 2 ]}\r\n ', True),
    ("top-level scalars", '"plain"', True),
    ("keys that differ only in case", '{"a":1,"A":2}', True),
    ("__proto__ is an ordinary member", '{"__proto__":{"x":1}}', True),
    ("number-like text inside a string", '{"s":"1.5e3 NaN"}', True),
    ("duplicate key", '{"a":1,"a":1}', False),
    ("duplicate key after unescaping", '{"a":1,"\\u0061":2}', False),
    ("nested duplicate key", '{"x":[{"k":1,"k":2}]}', False),
    ("NaN", '{"n":NaN}', False),
    ("Infinity", '{"n":Infinity}', False),
    ("-Infinity", '{"n":-Infinity}', False),
    ("fraction", '{"n":1.0}', False),
    ("exponent", '{"n":1e3}', False),
    ("signed exponent", '{"n":1E+3}', False),
    ("negative fraction", '{"n":-0.5}', False),
    ("above 2^53 - 1", '{"n":9007199254740992}', False),
    ("below -(2^53 - 1)", '{"n":-9007199254740992}', False),
    ("escaped NUL in a value", '{"s":"a\\u0000b"}', False),
    ("escaped NUL in a key", '{"a\\u0000":1}', False),
    ("escaped lone high surrogate", '{"s":"\\ud800"}', False),
    ("escaped lone low surrogate", '{"s":"\\udc00x"}', False),
    ("escaped reversed pair", '{"s":"\\ude00\\ud83d"}', False),
    ("escaped lone surrogate in a key", '{"\\ud800":1}', False),
    ("raw lone surrogate in a value", '{"s":"' + chr(0xD800) + '"}', False),
    ("raw lone surrogate in a key", '{"' + chr(0xDFFF) + '":1}', False),
    ("trailing comma", "[1,]", False),
    ("single quotes", "{'a':1}", False),
    ("text after the value", '{"a":1}x', False),
    ("empty text", "", False),
    ("leading zero", '{"a":01}', False),
    ("bad escape", '"\\x"', False),
    ("raw control character in a string", '"a\tb"', False),
    ("byte order mark", "\ufeff{}", False),
]


def test_strict_json_parser() -> None:
    import json

    for name, text, ok in STRICT_CASES:
        try:
            got = sc.parse_strict_json(text)
        except sc.StrictJsonError:
            assert not ok, f"strict parse refused a valid text: {name}"
        else:
            assert ok, f"strict parse accepted: {name}"
            assert sc.json_equal(got, json.loads(text)), name


def test_strict_counterexamples_fail_only_by_strictness() -> None:
    import json

    strict = [ex for ex in VECTORS["groups"]["wire_examples"]["examples"] if ex.get("why", "").endswith("A18)")]
    assert [ex["why"].split(":")[0] for ex in strict] == [
        "duplicate object key inside the bundle text",
        "NUL character in a string of the envelope text",
        "lone surrogate in a string of the bundle text",
        "non-integer number token inside the envelope text",
    ], strict
    for ex in strict:
        assert ex["expect_valid"] is False
        assert "not strict JSON text" in "\n".join(sc.wire_example_errors(OPENAPI, ex)), ex["why"]
        strict_parse = sc.parse_strict_json
        sc.parse_strict_json = json.loads  # the lenient parse a JSON-only check would use
        try:
            assert sc.wire_example_errors(OPENAPI, ex) == [], ex["why"]
        finally:
            sc.parse_strict_json = strict_parse


def test_enrollment_times_are_minute_precision() -> None:
    S = OPENAPI["components"]["schemas"]
    created = {
        "request_id": "6c9f2a3e-1b4d-4c8e-9a7f-2d5b8e1c0f3a",
        "expires_at": 1792052220000,
        "server_time": 1792051594787,
    }
    assert sc.validate(S["EnrollCreateResponse"], created, OPENAPI) == []
    assert "multiple of 60000" in "".join(
        sc.validate(S["EnrollCreateResponse"], dict(created, expires_at=1792051594787 + 600_000), OPENAPI)
    )
    item = {
        "request_id": created["request_id"],
        "created_at": 1792051560000,
        "expires_at": 1792052220000,
        "state": "pending",
    }
    assert sc.validate(S["EnrollListItem"], item, OPENAPI) == []
    assert "multiple of 60000" in "".join(
        sc.validate(S["EnrollListItem"], dict(item, expires_at=item["expires_at"] + 1), OPENAPI)
    )
    assert "multiple of 60000" in "".join(
        sc.validate(S["EnrollListItem"], dict(item, created_at=item["created_at"] + 1), OPENAPI)
    )


def test_every_operation_lists_413() -> None:
    import copy

    for method, path, op in sc.operations(OPENAPI):
        assert op["x-sixkey-errors"].get("413") == ["too_large"], (method, path)
        assert op["responses"].get("413") == {"$ref": "#/components/responses/Error"}, (method, path)
    bad = copy.deepcopy(OPENAPI)
    del bad["paths"]["/healthz"]["get"]["x-sixkey-errors"]["413"]
    del bad["paths"]["/v1/keys"]["get"]["x-sixkey-errors"]["413"]
    errs = sc.check_openapi(bad)
    assert [e for e in errs if "every operation lists 413 too_large" in e] == [
        "GET /healthz: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)",
        "GET /v1/keys: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)",
    ], errs
    assert "GET /healthz: error response 413 lists no codes" in errs


def test_rate_limits_of_revision_15() -> None:
    rl = OPENAPI["x-sixkey-rate-limits"]
    by_id = {lim["id"]: lim for lim in rl["limits"]}
    for lim_id, limit in (("session_writes", 30), ("session_reads", 60)):
        assert {k: by_id[lim_id][k] for k in ("key", "limit", "window_s")} == {
            "key": "account session",
            "limit": limit,
            "window_s": 60,
        }
    assert (
        "POST /v1/vault/init" in by_id["session_writes"]["applies_to"]
        and "POST /v1/enroll/requests" in by_id["session_writes"]["applies_to"]
    )
    assert "GET /v1/account" in by_id["session_reads"]["applies_to"]
    assert {k: by_id["otp_verify_code"][k] for k in ("key", "limit", "window_s")} == {
        "key": "email (HMAC), reset by a new code",
        "limit": 5,
        "window_s": None,
    }
    assert "malformed email is 401 otp_invalid" in by_id["otp_verify_code"]["applies_to"]
    rules = "\n".join(rl["rules"])
    assert (
        "invalid_proof_per_device; past the limit the request gets 429 rate_limited with Retry-After and never touches the database"
        in rules
    )
    assert "keyed enroll:{rid}" in rules


# ---- revision 16 (§0.0p, the M4 fix pass)


def test_rate_limits_of_revision_16() -> None:
    rl = OPENAPI["x-sixkey-rate-limits"]
    by_id = {lim["id"]: lim for lim in rl["limits"]}
    pick = lambda lid: {k: by_id[lid].get(k) for k in ("key", "limit", "window_s", "unit", "source")}  # noqa: E731
    assert pick("proof_valid_account") == {"key": "account", "limit": 60, "window_s": 60, "unit": None, "source": "m4"}
    assert pick("device_envelope_bytes") == {
        "key": "device",
        "limit": 268435456,
        "window_s": 3600,
        "unit": "bytes",
        "source": "m4",
    }
    assert pick("account_envelope_bytes") == {
        "key": "account",
        "limit": 1073741824,
        "window_s": 3600,
        "unit": "bytes",
        "source": "m4",
    }
    assert "revoke and rotate included; an invalid proof never enters it" in by_id["proof_valid_account"]["applies_to"]
    assert (
        "without a valid proof" in by_id["device_envelope_bytes"]["applies_to"]
        and "never refunded" in by_id["device_envelope_bytes"]["applies_to"]
    )
    assert "refunded when the request ends in 401 or 403" in by_id["account_envelope_bytes"]["applies_to"]
    assert [lim["id"] for lim in rl["limits"] if "unit" in lim] == [
        "device_envelope_bytes",
        "account_envelope_bytes",
        "session_envelope_bytes",
    ]  # + revision 18
    assert [lim["id"] for lim in rl["limits"] if lim["source"] == "m4"] == [
        "proof_valid_account",
        "device_envelope_bytes",
        "account_envelope_bytes",
        "session_envelope_bytes",
    ]
    rules = "\n".join(rl["rules"])
    assert "never subject to the account-level ceiling" not in rules
    for needle in (
        "Revocation and rotation are not subject to account_writes (F8), but they are subject to proof_valid_account and account_envelope_bytes; an invalid proof never enters proof_valid_account",
        "with one exception: device_envelope_bytes keeps what",
        "An IP key counts an IPv4 address, or the /64 of an IPv6 address; an IPv4-mapped IPv6 address counts as its IPv4 address",
        "Each limiter table holds at most 200000 keys; a request that needs a new key once a table is full gets 429 rate_limited",
    ):
        assert needle in rules, needle


def test_the_checker_rejects_malformed_rate_limits() -> None:
    import copy

    bad = copy.deepcopy(OPENAPI)
    lims = bad["x-sixkey-rate-limits"]["limits"]
    by_id = {lim["id"]: lim for lim in lims}
    by_id["device_envelope_bytes"]["unit"] = "kib"
    by_id["account_envelope_bytes"]["window_s"] = None
    by_id["proof_valid_account"]["source"] = "m5"
    by_id["otp_send_ip"]["limit"] = 0
    by_id["device_writes"]["burst"] = 5
    lims.append(dict(by_id["device_reads"]))
    errs = sc.check_openapi(bad)
    for needle in (
        "rate limit device_envelope_bytes: unit must be bytes when present",
        "rate limit account_envelope_bytes: a byte budget needs a window",
        "rate limit proof_valid_account: source must be doc or m4",
        "rate limit otp_send_ip: limit must be a positive integer",
        "rate limit device_writes: unknown members ['burst']",
        "rate limit device_reads: id missing or duplicate",
    ):
        assert needle in errs, (needle, errs)


def test_request_rules() -> None:
    import copy

    rr = OPENAPI["x-sixkey-request-rules"]
    assert [r["id"] for r in rr] == ["json_content_type"]
    assert {k: rr[0][k] for k in ("applies_to", "status", "code", "source")} == {
        "applies_to": "with_request_body",
        "status": 422,
        "code": "invalid_request",
        "source": "doc",
    }
    assert (
        "the media type is application/json, case-insensitive, optionally followed by one parameter charset=utf-8"
        in rr[0]["rule"]
    )  # revision 18 wording
    assert "before reading the body; otherwise 422 invalid_request" in rr[0]["rule"]
    bodied = [(m, p, op) for m, p, op in sc.operations(OPENAPI) if "requestBody" in op]
    assert len(bodied) == 19
    for m, p, op in bodied:
        assert "invalid_request" in op["x-sixkey-errors"]["422"], (m, p)
    bad = copy.deepcopy(OPENAPI)
    bad["paths"]["/v1/enroll/requests/{rid}/approve"]["post"]["x-sixkey-errors"]["422"] = ["key_mismatch"]
    bad["paths"]["/v1/auth/otp"]["post"]["requestBody"]["content"]["text/plain"] = {"schema": {"type": "string"}}
    errs = sc.check_openapi(bad)
    assert (
        "POST /v1/enroll/requests/{rid}/approve: request rule json_content_type needs 422 invalid_request in x-sixkey-errors"
        in errs
    ), errs
    assert "POST /v1/auth/otp: a request body must be application/json only" in errs, errs
    bad2 = copy.deepcopy(OPENAPI)
    bad2["x-sixkey-request-rules"][0]["status"] = 400
    assert "request rule json_content_type: invalid_request is not a 400 code" in sc.check_openapi(bad2)
    bad3 = copy.deepcopy(OPENAPI)
    del bad3["x-sixkey-request-rules"]
    assert "x-sixkey-request-rules: json_content_type is missing" in sc.check_openapi(bad3)


def test_session_503_and_reject_all_texts() -> None:
    acct = OPENAPI["components"]["securitySchemes"]["accountSession"]["description"]
    assert "aud must be exactly the string authenticated (not a list) and role must be authenticated" in acct
    assert "aud = authenticated" not in acct
    u = OPENAPI["x-sixkey-error-codes"]["unavailable"]
    assert (u["status"], u["applies_to"], u["details"]) == (503, "any", ["retry_after"])
    for needle in (
        "waiting longer than 5 s for a database connection",
        "waiting longer than 10 s for one of the slots of the three 9 MiB endpoints",
        "a request body not read within 60 s",
        "a retryable database conflict (deadlock or serialization failure)",
        "Past uvicorn's limit_concurrency the server process itself answers 503 without a JSON error body",
        "clients treat any 503 as unavailable",
    ):
        assert needle in u["meaning"], needle
    ra = OPENAPI["paths"]["/v1/enroll/reject-all"]["post"]["description"]
    assert "created_at <= minute_floor(Sixkey-Ts)" in ra
    assert (
        "The bound is the client-signed Sixkey-Ts, not the server's clock, so clients must sign with the server-corrected time (§4.14)"
        in ra
    )


# ---- revision 18 (§0.0r, the M4 cleanup round)

R18_TEXTS = {
    "device_envelope_bytes": "PUT /v1/vault and POST /v1/keys/rotate requests without a valid proof, counted by the whole request body including bodies that fail to parse (422/413); never refunded",
    "account_envelope_bytes": "every PUT /v1/vault and POST /v1/keys/rotate request, valid proof or not, counted by the whole request body including bodies that fail to parse; refunded when the request ends in 401 or 403",
    "session_envelope_bytes": "POST /v1/vault/init only, parsed or not, counted by the whole request body; refunded when the request ends in 401 or 403",
}
R18_RULES = [
    "Requests rejected with 401 or 403 never count against any quota, with one exception: device_envelope_bytes keeps what the PUT /v1/vault and POST /v1/keys/rotate requests it applies to used (§5.5, §0.0p, §0.0r).",
    "A limit with unit bytes counts the whole request body's bytes, including a body that does not parse (422 or 413); every other limit counts requests.",
    "A request whose body does not parse carries no valid proof and pays every bucket that applies to it (device_writes, the account ceiling, device_envelope_bytes and account_envelope_bytes; for init, session_writes and session_envelope_bytes).",
    "An enrolling device (Sixkey-Enroll) is limited like a device keyed enroll:{rid} (device_writes, device_reads); it does not count toward account_reads or account_writes (§5.5, §0.0r A21).",
    "Each limiter table holds at most 200000 keys; a request that needs a new key once a table is full gets 429 rate_limited with Retry-After 60 (§5.5, §0.0p, §0.0r, M4 S5).",
]
R18_CONTENT_TYPE = (
    "the media type is application/json, case-insensitive, optionally followed by one parameter charset=utf-8 (case-insensitive), "
    "with optional whitespace around the ';'. charset=utf8, a quoted value, any other parameter, a trailing ';' and 'charset = utf-8' are 422."
)


def test_rate_limits_of_revision_18() -> None:
    rl = OPENAPI["x-sixkey-rate-limits"]
    by_id = {lim["id"]: lim for lim in rl["limits"]}
    for lid, text in R18_TEXTS.items():
        assert by_id[lid]["applies_to"] == text, lid
    assert by_id["session_envelope_bytes"] == {
        "id": "session_envelope_bytes",
        "key": "account session",
        "limit": 1073741824,
        "window_s": 3600,
        "unit": "bytes",
        "applies_to": R18_TEXTS["session_envelope_bytes"],
        "section": "§5.5 (§0.0r, M4 RR1)",
        "source": "m4",
    }
    for lid in ("device_envelope_bytes", "account_envelope_bytes"):
        assert "init" not in by_id[lid]["applies_to"], lid
    for rule in R18_RULES:
        assert rule in rl["rules"], rule
    rules = "\n".join(rl["rules"])
    assert "counts toward the account ceiling" not in rules and "counts request bytes;" not in rules
    assert by_id["otp_verify_code"]["applies_to"].endswith(
        "; if the counter table is full and this email has no counter yet, 429 rate_limited with Retry-After 60, and the provider is not asked"
    )
    assert (
        "429" in OPENAPI["paths"]["/v1/auth/verify"]["post"]["x-sixkey-errors"]
        and "rate_limited" in OPENAPI["paths"]["/v1/auth/verify"]["post"]["x-sixkey-errors"]["429"]
    )
    assert R18_CONTENT_TYPE in OPENAPI["x-sixkey-request-rules"][0]["rule"]


def test_rate_limit_rules_name_only_known_buckets() -> None:
    import copy

    bad = copy.deepcopy(OPENAPI)
    bad["x-sixkey-rate-limits"]["limits"] = [
        lim for lim in bad["x-sixkey-rate-limits"]["limits"] if lim["id"] != "session_envelope_bytes"
    ]
    bad["x-sixkey-rate-limits"]["rules"].append("Rotation also pays rotate_bytes.")
    errs = sc.check_openapi(bad)
    for name in ("session_envelope_bytes", "rotate_bytes"):
        assert f"rate-limit rule names {name}, which is no limit id, error code or schema property" in errs, (
            name,
            errs,
        )


# ---- revision 27 (§0.0aa, enrolment v2 and the pairing code)


def _fails(verifier, group: dict, vectors: dict = VECTORS) -> bool:
    try:
        verifier(group, vectors)
    except sc.Fail:
        return True
    return False


def test_enrolment_v2_verifiers_catch_regressions() -> None:
    """Each of these is a way the v2 enrolment could silently fall back to v1; the verifiers must refuse every one."""
    import copy

    g = VECTORS["groups"]
    enr = g["enrollment"]
    i = enr["inputs"]
    z = bytes.fromhex(enr["z_hex"])
    h = bytes.fromhex(enr["h_hex"])
    cases = {}
    bad = copy.deepcopy(enr)
    bad["k_enroll_hex"] = sc.hkdf(z, h, "sixkey/v2/enroll-key", 32).hex()  # K from Z only
    cases["K from Z only"] = bad
    bad = copy.deepcopy(enr)
    bad["k_enroll_hex"] = sc.hkdf(z, h, "sixkey/v1/enroll-key", 32).hex()  # the v1 derivation
    cases["the v1 key"] = bad
    bad = copy.deepcopy(enr)
    bad["payload"]["plaintext"] = bad["payload"]["plaintext"].replace('"v":2', '"v":1')
    cases["payload v 1"] = bad
    bad = copy.deepcopy(enr)
    bad["reveal_name"]["aad"] = bad["reveal_name"]["aad"].replace("|2|", "|1|")
    cases["the v1 name AAD"] = bad
    bad = copy.deepcopy(enr)
    bad["commit_input"] = bad["commit_input"].replace("commit|2|", "commit|1|")
    cases["the v1 commitment tag"] = bad
    bad = copy.deepcopy(enr)
    bad["cc"] = "123456"
    cases["a confirmation code"] = bad
    bad = copy.deepcopy(enr)
    bad["inputs"]["ikm_hex"] = i["ikm_hex"][:64]  # Z without S
    cases["IKM without S"] = bad
    bad = copy.deepcopy(enr)
    bad["label_swap"]["as_pairing_code"] = bad["label_swap"]["as_recovery_code"]
    cases["pairing code with untagged check bits"] = bad
    bad = copy.deepcopy(enr)
    bad["must_not_open"] = [m for m in bad["must_not_open"] if not m["name"].startswith("K from Z only")]
    cases["no Z-only case"] = bad
    for name, b in cases.items():
        assert _fails(sc.v_enrollment, b), f"v_enrollment accepted: {name}"

    sas = copy.deepcopy(g["sas"])
    sas["cases"][0]["sas"] = sc.six_digits("sixkey/v1/enroll-sas|", bytes.fromhex(sas["cases"][0]["h_hex"]))[1]
    assert _fails(sc.v_sas, sas), "v_sas accepted the v1 SAS tag"

    pc = copy.deepcopy(g["pairing_code"])
    pc["cases"][2]["code"] = sc.recovery_format(bytes.fromhex(pc["cases"][2]["secret_hex"]))
    assert _fails(sc.v_pairing_code, pc), "v_pairing_code accepted untagged check bits"
    pc = copy.deepcopy(g["pairing_code"])
    pc["rejected_inputs"] = [r for r in pc["rejected_inputs"] if r["input"] != g["recovery_auth"]["code"]]
    assert _fails(sc.v_pairing_code, pc), "v_pairing_code accepted a group without the recovery-code case"

    labels = copy.deepcopy(g["labels"])
    labels["domain_tags"].append(
        {"tag": "sixkey/v1/enroll-confirm|", "kind": "sha256-prefix", "status": "new", "section": "x"}
    )
    assert _fails(sc.v_labels, labels), "v_labels accepted the confirmation-code tag"
    labels = copy.deepcopy(g["labels"])
    labels["hkdf_info"] = [x for x in labels["hkdf_info"] if x["label"] != "sixkey/v2/enroll-key"]
    assert _fails(sc.v_labels, labels), "v_labels accepted a list without the v2 enrolment key label"


def test_vector_schema_closes_the_enrolment_group() -> None:
    """A confirmation code, or any member the schema does not name, at the enrolment group's own level fails the schema
    too (the verifier refuses it as well; the schema is the first line)."""
    import copy

    for extra in ({"cc": "123456"}, {"cc_u32": 1}, {"confirm": "x"}):
        broken = copy.deepcopy(VECTORS)
        broken["groups"]["enrollment"].update(extra)
        errs = sc.validate(VECTOR_SCHEMA, broken, VECTOR_SCHEMA)
        assert any("enrollment" in e for e in errs), (extra, errs)


def test_h8_reads_the_contract_text_too() -> None:
    """check_consistency.py H8 refuses a v1 enrolment tag, an unknown label or the retired confirmation code in
    api/openapi.yaml, not only in the design document (revision 27)."""
    import contextlib
    import io
    import runpy
    import tempfile

    checker = os.path.join(_HERE, "..", "tools", "check_consistency.py")
    g = runpy.run_path(checker, run_name="check_consistency")["main"].__globals__  # the module's own globals
    with open(g["OPENAPI"], encoding="utf-8") as f:
        text = f.read()

    def run(openapi_text: str) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "openapi.yaml")
            with open(path, "w", encoding="utf-8") as f:
                f.write(openapi_text)
            g["OPENAPI"] = path
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = g["main"]()
        return code, out.getvalue()

    assert run(text)[0] == 0
    tag = "sixkey-enroll-name|2|"
    assert tag in text
    for bad, want in (
        (text.replace(tag, "sixkey-enroll-name|1|", 1), "names sixkey-enroll-name|1|"),
        (text.replace(tag, "sixkey/v9/enroll-key", 1), "names sixkey/v9/enroll-key"),
        (text.replace("the real protection is", "the real protection is CC and", 1), "confirmation code (CC)"),
    ):
        code, out = run(bad)
        assert code == 1 and want in out, (want, out[-400:])


def test_pairing_code_python_reference() -> None:
    s = bytes(range(0x38, 0x48))
    code = sc.pairing_format(s)
    assert sc.pairing_parse(code) == s and sc.pairing_parse(code.lower().replace("-", " ")) == s
    assert sc.recovery_format(s) != code
    for text, want in (
        (sc.recovery_format(s), "pairing_checksum"),
        (code[:-1], "pairing_length"),
        (code[:-1] + "U", "pairing_char"),
    ):
        try:
            sc.pairing_parse(text)
        except ValueError as e:
            assert str(e) == want, (text, e)
        else:
            raise AssertionError(f"accepted {text}")


def main() -> int:
    tests = [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)]
    failed = 0
    t0 = time.time()
    for n, f in tests:
        try:
            f()
            print(f"PASS {n}")
        except Exception:  # noqa: BLE001 - report every failure
            failed += 1
            print(f"FAIL {n}")
            traceback.print_exc()
    print()
    print("Per-group verification (what each Python side checked):")
    for g, res in REPORT.items():
        print(f"  {g:18} stdlib: {res['python-stdlib']:<8} cryptography: {res['python-cryptography']}")
    print()
    print(f"cryptography importable: {sc.HAVE_CRYPTOGRAPHY}")
    print(f"{len(tests) - failed}/{len(tests)} passed in {time.time() - t0:.1f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
