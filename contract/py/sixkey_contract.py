"""Sixkey Phase 1 M0 contract: Python loader, validators and a separately written reference implementation
(separate code, not independent authorship: see contract/M0-NOTES.md, "Caveats on independence").

Everything here is Python standard library (hashlib, hmac, HKDF written out, pbkdf2_hmac, unicodedata, and
pure-Python P-256 arithmetic for ECDH, public-key derivation and ECDSA verification). AES-GCM is not in the
standard library, so the AES-GCM checks use pyca/cryptography when it is importable and are reported as skipped
otherwise; when cryptography is present it also re-checks ECDH and ECDSA.

The pure-Python elliptic-curve code is a test-only reference: not constant time, never for real keys.

Run: python3 -I contract/py/test_contract.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import unicodedata
from typing import Any, Callable

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
VECTORS_PATH = os.path.join(ROOT, "contract", "vectors", "sync-v1.json")
VECTOR_SCHEMA_PATH = os.path.join(ROOT, "contract", "vectors", "sync-v1.schema.json")
OPENAPI_PATH = os.path.join(ROOT, "api", "openapi.yaml")

try:  # optional, only for AES-GCM (plus a second ECDH/ECDSA opinion)
    if os.environ.get("SIXKEY_CONTRACT_NO_CRYPTOGRAPHY"):  # lets the stdlib-only path be exercised on purpose
        raise ImportError("disabled by SIXKEY_CONTRACT_NO_CRYPTOGRAPHY")
    from cryptography.exceptions import InvalidSignature, InvalidTag
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    HAVE_CRYPTOGRAPHY = True
except Exception:  # pragma: no cover - depends on the machine
    HAVE_CRYPTOGRAPHY = False


def load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_all() -> tuple[Any, Any, Any]:
    """The vectors, their JSON Schema, and the OpenAPI document (JSON syntax, valid YAML 1.2)."""
    return load_json(VECTORS_PATH), load_json(VECTOR_SCHEMA_PATH), load_json(OPENAPI_PATH)


class Fail(AssertionError):
    pass


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


# ------------------------------------------------------------------------------------------------ JSON Schema subset

ANNOTATIONS = {
    "$schema",
    "$id",
    "$comment",
    "title",
    "description",
    "$defs",
    "format",
    "examples",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "contentMediaType",
}
ASSERTIONS = {
    "$ref",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "enum",
    "const",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "multipleOf",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "contains",
    "contentSchema",
    "if",
    "then",
    "else",
}  # revision 7: the enrollment views require fields by state (§0.0f F-10)


def json_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    return a == b


def ecma_pattern(p: str) -> "re.Pattern[str]":
    """ECMA-262 '$' never matches before a trailing newline; Python's does. The subset only uses '$' at the end."""
    if p.endswith("$") and not p.endswith("\\$"):
        p = p[:-1] + r"\Z"
    return re.compile(p)


def is_type(v: Any, t: str) -> bool:
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "null":
        return v is None
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    raise Fail(f"unknown type {t}")


def resolve_pointer(root: Any, ref: str) -> Any:
    check(isinstance(ref, str) and ref.startswith("#"), f"only local $ref is supported: {ref!r}")
    node = root
    if ref in ("#", "#/"):
        return node
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(part)]
        elif isinstance(node, dict) and part in node:
            node = node[part]
        else:
            raise Fail(f"$ref does not resolve: {ref}")
    return node


def lint_schema(schema: Any, where: str) -> None:
    """Reject any keyword the two validators do not implement, so a schema can never silently rely on one."""
    if isinstance(schema, bool):
        return
    check(isinstance(schema, dict), f"{where}: a schema must be an object or a boolean")
    for k, v in schema.items():
        if k.startswith("x-"):
            continue
        check(k in ANNOTATIONS or k in ASSERTIONS, f"{where}: unsupported schema keyword {k!r}")
        if k in ("properties", "$defs"):
            for name, sub in v.items():
                lint_schema(sub, f"{where}/{k}/{name}")
        elif k in ("items", "additionalProperties", "not", "contains", "contentSchema", "if", "then", "else"):
            lint_schema(v, f"{where}/{k}")
        elif k in ("oneOf", "anyOf", "allOf"):
            for i, sub in enumerate(v):
                lint_schema(sub, f"{where}/{k}/{i}")


class StrictJsonError(ValueError):
    pass


_SAFE_INT = 2**53 - 1


def _strict_fail(why: str) -> Any:
    raise StrictJsonError(why)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict:
    out: dict = {}
    for k, v in pairs:  # keys arrive decoded, so "a" and "\u0061" are the same key
        if k in out:
            _strict_fail(f"duplicate object key {k!r}")
        out[k] = v
    return out


def _strict_int(tok: str) -> int:
    v = int(tok)
    if abs(v) > _SAFE_INT:
        _strict_fail("integer outside the safe range")
    return v


def parse_strict_json(text: str) -> Any:
    """The JSON every party agrees on (§2.3 N20, §5.4, §0.0o A18): the JSON.parse grammar (so no NaN or Infinity),
    every number token an integer literal with |n| <= 2^53 - 1, no duplicate object key (compared after unescaping),
    and no NUL or lone surrogate in any key or string. Used for every nested JSON text (contentSchema); raises
    StrictJsonError. Python merges an escaped surrogate pair into one code point, so a surrogate left over is lone."""
    try:
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_int=_strict_int,
            parse_float=lambda tok: _strict_fail(f"non-integer number token {tok}"),
            parse_constant=lambda tok: _strict_fail(f"{tok} is not JSON"),
        )
    except StrictJsonError:
        raise
    except (ValueError, RecursionError):
        raise StrictJsonError("not JSON text") from None
    stack = [value]
    while stack:
        x = stack.pop()
        if isinstance(x, str):
            if "\x00" in x:
                _strict_fail("NUL character in a string")
            if any(0xD800 <= ord(ch) <= 0xDFFF for ch in x):
                _strict_fail("lone surrogate in a string")
        elif isinstance(x, dict):
            stack.extend(x.keys())
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
    return value


def validate(schema: Any, inst: Any, root: Any, path: str = "$") -> list[str]:
    if schema is True:
        return []
    if schema is False:
        return [f"{path}: not allowed"]
    errs: list[str] = []
    s = schema
    if "$ref" in s:
        errs += validate(resolve_pointer(root, s["$ref"]), inst, root, path)
    if "type" in s:
        types = s["type"] if isinstance(s["type"], list) else [s["type"]]
        if not any(is_type(inst, t) for t in types):
            return errs + [f"{path}: expected {types}, got {type(inst).__name__}"]
    if "enum" in s and not any(json_equal(inst, e) for e in s["enum"]):
        errs.append(f"{path}: not one of {s['enum']}")
    if "const" in s and not json_equal(inst, s["const"]):
        errs.append(f"{path}: must equal {s['const']!r}")
    if isinstance(inst, str):
        n = len(inst)  # code points, as in JSON Schema
        if "minLength" in s and n < s["minLength"]:
            errs.append(f"{path}: shorter than {s['minLength']}")
        if "maxLength" in s and n > s["maxLength"]:
            errs.append(f"{path}: longer than {s['maxLength']}")
        if "pattern" in s and not ecma_pattern(s["pattern"]).search(inst):
            errs.append(f"{path}: does not match {s['pattern']}")
        if "contentSchema" in s and s.get("contentMediaType") == "application/json":
            try:
                parsed = parse_strict_json(inst)  # §0.0o A18 and M4 review S14: nested texts are parsed strictly
            except StrictJsonError as e:
                errs.append(f"{path}: not strict JSON text ({e})")
            else:
                errs += validate(s["contentSchema"], parsed, root, f"{path}<json>")
    if is_type(inst, "number"):
        if "minimum" in s and inst < s["minimum"]:
            errs.append(f"{path}: below {s['minimum']}")
        if "maximum" in s and inst > s["maximum"]:
            errs.append(f"{path}: above {s['maximum']}")
        if "multipleOf" in s and inst % s["multipleOf"] != 0:
            errs.append(f"{path}: not a multiple of {s['multipleOf']}")
    if isinstance(inst, list):
        if "minItems" in s and len(inst) < s["minItems"]:
            errs.append(f"{path}: fewer than {s['minItems']} items")
        if "maxItems" in s and len(inst) > s["maxItems"]:
            errs.append(f"{path}: more than {s['maxItems']} items")
        if s.get("uniqueItems"):
            for i in range(len(inst)):
                for j in range(i + 1, len(inst)):
                    if json_equal(inst[i], inst[j]):
                        errs.append(f"{path}: items {i} and {j} are equal")
        if "items" in s:
            for i, item in enumerate(inst):
                errs += validate(s["items"], item, root, f"{path}[{i}]")
        if "contains" in s and not any(not validate(s["contains"], item, root, path) for item in inst):
            errs.append(f"{path}: no item matches 'contains'")
    if isinstance(inst, dict):
        for r in s.get("required", []):
            if r not in inst:
                errs.append(f"{path}: missing {r!r}")
        props = s.get("properties", {})
        for k, v in inst.items():
            if k in props:
                errs += validate(props[k], v, root, f"{path}.{k}")
            elif "additionalProperties" in s:
                errs += validate(s["additionalProperties"], v, root, f"{path}.{k}")
    for sub in s.get("allOf", []):
        errs += validate(sub, inst, root, path)
    if "anyOf" in s and not any(not validate(sub, inst, root, path) for sub in s["anyOf"]):
        errs.append(f"{path}: matches no anyOf branch")
    if "oneOf" in s:
        n_ok = sum(1 for sub in s["oneOf"] if not validate(sub, inst, root, path))
        if n_ok != 1:
            errs.append(f"{path}: matches {n_ok} oneOf branches, expected exactly 1")
    if "not" in s and not validate(s["not"], inst, root, path):
        errs.append(f"{path}: matches 'not'")
    if "if" in s:
        branch = s.get("then") if not validate(s["if"], inst, root, path) else s.get("else")
        if branch is not None:
            errs += validate(branch, inst, root, path)
    return errs


# ------------------------------------------------------------------------------------------------ OpenAPI checks

HTTP_METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")
SIGNERS = {"none", "device", "enroll", "registration", "device_or_enroll"}
ACCOUNT = {"none", "required", "step_up"}
PW = {"none", "required", "password_or_recovery", "device_only"}
REQUIRED_CONSTANTS = {
    "MAX_ENVELOPE_BYTES",
    "MAX_BODY_BYTES_VAULT",
    "MAX_BODY_BYTES_OTHER",
    "PAD_BUCKET_BYTES",
    "DEVICE_NAME_MAX_CODE_POINTS",
    "DEVICE_NAME_PADDED_BYTES",
    "KEYRING_PREVIOUS_MAX",
    "KVER_MAX_JUMP",
    "PBKDF2_MIN_ITERATIONS",
    "PBKDF2_MAX_ITERATIONS",
    "SIG_WINDOW_S",
    "ENROLL_TTL_S",
}


def walk(node: Any, fn: Callable[[Any, str], None], path: str = "#") -> None:
    fn(node, path)
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, fn, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, fn, f"{path}/{i}")


def operations(o: Any) -> list[tuple[str, str, dict]]:
    out = []
    for p, item in o["paths"].items():
        for m, op in item.items():
            if m in HTTP_METHODS:
                out.append((m.upper(), p, op))
    return out


def deref(o: Any, node: Any) -> Any:
    while isinstance(node, dict) and "$ref" in node and len(node) == 1:
        node = resolve_pointer(o, node["$ref"])
    return node


def schema_props(o: Any, schema: Any) -> tuple[set[str], set[str]]:
    """Top-level property names and required names of a request schema (following $ref and allOf)."""
    s = deref(o, schema)
    props, req = set(s.get("properties", {})), set(s.get("required", []))
    for sub in s.get("allOf", []):
        p2, r2 = schema_props(o, sub)
        props |= p2
        req |= r2
    return props, req


def requires_server_time(o: Any, schema: Any) -> bool:
    s = deref(o, schema)
    if "oneOf" in s:
        return all(requires_server_time(o, b) for b in s["oneOf"])
    return "server_time" in s.get("required", []) and "server_time" in s.get("properties", {})


def request_schema(op: dict) -> Any:
    rb = op.get("requestBody")
    return rb["content"]["application/json"]["schema"] if rb else None


def check_openapi(o: Any) -> list[str]:
    errs: list[str] = []

    def need(cond: bool, msg: str) -> None:
        if not cond:
            errs.append(msg)

    need(
        isinstance(o.get("openapi"), str) and re.fullmatch(r"3\.1\.\d+", o["openapi"]) is not None,
        "openapi must be 3.1.x",
    )
    need(bool(o.get("info", {}).get("title")) and bool(o.get("info", {}).get("version")), "info.title and info.version")

    def ref_ok(node: Any, path: str) -> None:
        if isinstance(node, dict) and "$ref" in node:
            try:
                resolve_pointer(o, node["$ref"])
            except Fail as e:
                errs.append(f"{path}: {e}")

    walk(o, ref_ok)

    comps = o["components"]
    try:
        for name, sch in comps["schemas"].items():
            lint_schema(sch, f"#/components/schemas/{name}")
        for name, prm in comps.get("parameters", {}).items():
            lint_schema(prm["schema"], f"#/components/parameters/{name}/schema")
        for name, hdr in comps.get("headers", {}).items():
            lint_schema(hdr["schema"], f"#/components/headers/{name}/schema")
    except Fail as e:
        errs.append(str(e))

    codes = comps["schemas"]["ErrorCode"]["enum"]
    table = o["x-sixkey-error-codes"]
    need(len(codes) == len(set(codes)), "ErrorCode enum has duplicates")
    need(set(codes) == set(table), f"ErrorCode enum vs x-sixkey-error-codes: {sorted(set(codes) ^ set(table))}")
    for c, e in table.items():
        need(isinstance(e.get("status"), int) and 400 <= e["status"] <= 599, f"{c}: status")
        need(
            bool(e.get("meaning")) and bool(e.get("section")) and e.get("source") in ("doc", "m0"),
            f"{c}: meaning/section/source",
        )
        need(e.get("applies_to", "listed") in ("listed", "any"), f"{c}: applies_to")

    schemes = comps["securitySchemes"]
    consts = o["x-sixkey-constants"]
    need(REQUIRED_CONSTANTS <= set(consts), f"missing constants {sorted(REQUIRED_CONSTANTS - set(consts))}")
    for k, c in consts.items():
        need(isinstance(c.get("value"), int) and not isinstance(c.get("value"), bool), f"constant {k}: integer value")
        need(
            c.get("source") in ("doc", "m0")
            and c.get("enforced_by") in ("client", "server", "both")
            and bool(c.get("section")),
            f"constant {k}: source/enforced_by/section",
        )
    vault_limit, other_limit = consts["MAX_BODY_BYTES_VAULT"]["value"], consts["MAX_BODY_BYTES_OTHER"]["value"]
    need(vault_limit > consts["MAX_ENVELOPE_BYTES"]["value"], "vault body limit must exceed MAX_ENVELOPE_BYTES")
    _check_rate_limits(o["x-sixkey-rate-limits"], need)
    _check_rate_limit_names(o, need)
    _check_request_rules(o, table, need)

    used: set[str] = set()
    op_ids: set[str] = set()
    for method, path, op in operations(o):
        try:
            _check_operation(o, method, path, op, table, schemes, vault_limit, other_limit, used, op_ids, errs)
        except Fail as e:
            errs.append(f"{method} {path}: {e}")
    for c, e in table.items():
        if e.get("applies_to") != "any":
            need(c in used, f"error code {c} is not used by any operation")
    _check_removed(o, codes, table, errs)
    return errs


RATE_LIMIT_MEMBERS = {"id", "key", "limit", "window_s", "unit", "applies_to", "section", "source"}
REQUEST_RULE_MEMBERS = {"id", "applies_to", "status", "code", "section", "source", "rule"}


def _pos_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _check_rate_limits(rl: Any, need: Callable[[bool, str], None]) -> None:
    """x-sixkey-rate-limits (§5.5): rules are sentences; each limit has a unique id, a positive integer limit, a
    window in seconds or null, a key, what it applies to, a section, source doc or m4 (§0.0p), and unit bytes
    for a byte budget (absent: it counts requests); a byte budget always has a window."""
    rules = rl.get("rules")
    need(
        isinstance(rules, list) and bool(rules) and all(isinstance(r, str) and r for r in rules),
        "rate-limit rules: a list of sentences",
    )
    ids: set = set()
    for lim in rl.get("limits", []):
        lid = lim.get("id")
        need(isinstance(lid, str) and bool(lid) and lid not in ids, f"rate limit {lid}: id missing or duplicate")
        ids.add(lid)
        need(
            set(lim) <= RATE_LIMIT_MEMBERS, f"rate limit {lid}: unknown members {sorted(set(lim) - RATE_LIMIT_MEMBERS)}"
        )
        need(_pos_int(lim.get("limit")), f"rate limit {lid}: limit must be a positive integer")
        need(
            "window_s" in lim and (lim["window_s"] is None or _pos_int(lim["window_s"])),
            f"rate limit {lid}: window_s must be a positive integer or null",
        )
        need(
            all(isinstance(lim.get(k), str) and lim[k] for k in ("key", "applies_to", "section")),
            f"rate limit {lid}: key/applies_to/section",
        )
        need(lim.get("source") in ("doc", "m4"), f"rate limit {lid}: source must be doc or m4")
        need("unit" not in lim or lim["unit"] == "bytes", f"rate limit {lid}: unit must be bytes when present")
        need(
            lim.get("unit") != "bytes" or lim.get("window_s") is not None,
            f"rate limit {lid}: a byte budget needs a window",
        )


SNAKE = re.compile(r"\b[a-z]+(?:_[a-z]+)+\b")


def _check_rate_limit_names(o: Any, need: Callable[[bool, str], None]) -> None:
    """Every snake_case name in the rate-limit rules is a limit id, an error code or a schema property (such as
    password_auth), so a rule can never name a bucket the table does not have (§0.0r)."""
    rl = o["x-sixkey-rate-limits"]
    known = {lim.get("id") for lim in rl.get("limits", [])} | set(o["x-sixkey-error-codes"])
    for sch in o["components"]["schemas"].values():
        known |= set(sch.get("properties", {})) if isinstance(sch, dict) else set()
    for rule in rl.get("rules", []):
        for name in SNAKE.findall(rule if isinstance(rule, str) else ""):
            need(name in known, f"rate-limit rule names {name}, which is no limit id, error code or schema property")


def _check_request_rules(o: Any, table: dict, need: Callable[[bool, str], None]) -> None:
    """x-sixkey-request-rules (§5.4, §0.0p): each rule names the error it answers with, which must be a code of that
    status, and every operation it applies to must list that code. The JSON Content-Type rule must be there, and
    every request body must be application/json only."""
    rr = o.get("x-sixkey-request-rules")
    need(isinstance(rr, list) and bool(rr), "x-sixkey-request-rules: a non-empty list")
    rr = rr if isinstance(rr, list) else []
    need("json_content_type" in [r.get("id") for r in rr], "x-sixkey-request-rules: json_content_type is missing")
    seen: set = set()
    for r in rr:
        rid = r.get("id")
        need(isinstance(rid, str) and bool(rid) and rid not in seen, f"request rule {rid}: id missing or duplicate")
        seen.add(rid)
        need(set(r) == REQUEST_RULE_MEMBERS, f"request rule {rid}: members must be {sorted(REQUEST_RULE_MEMBERS)}")
        need(r.get("applies_to") in ("with_request_body", "all"), f"request rule {rid}: applies_to")
        need(
            r.get("source") in ("doc", "m0", "m4") and bool(r.get("section")) and bool(r.get("rule")),
            f"request rule {rid}: source/section/rule",
        )
        code, status = r.get("code"), r.get("status")
        need(code in table and table[code]["status"] == status, f"request rule {rid}: {code} is not a {status} code")
        for method, path, op in operations(o):
            if r.get("applies_to") == "all" or "requestBody" in op:
                need(
                    code in op.get("x-sixkey-errors", {}).get(str(status), []),
                    f"{method} {path}: request rule {rid} needs {status} {code} in x-sixkey-errors",
                )
    for method, path, op in operations(o):
        if "requestBody" in op:
            need(
                list(op["requestBody"].get("content", {})) == ["application/json"],
                f"{method} {path}: a request body must be application/json only",
            )


def _check_operation(
    o: Any,
    method: str,
    path: str,
    op: dict,
    table: dict,
    schemes: dict,
    vault_limit: int,
    other_limit: int,
    used: set,
    op_ids: set,
    errs: list,
) -> None:
    def need(cond: bool, msg: str) -> None:
        if not cond:
            errs.append(msg)

    where = f"{method} {path}"
    oid = op.get("operationId")
    need(bool(oid) and oid not in op_ids, f"{where}: operationId missing or duplicate")
    op_ids.add(oid)
    params = [deref(o, p) for p in op.get("parameters", [])]
    names = {(p["in"], p["name"]) for p in params}
    for t in re.findall(r"\{([^}]+)\}", path):
        need(
            any(p["in"] == "path" and p["name"] == t and p.get("required") for p in params),
            f"{where}: path parameter {t} not declared",
        )
    for req in op.get("security", []):
        for s in req:
            need(s in schemes, f"{where}: unknown security scheme {s}")
    auth = op.get("x-sixkey-auth")
    if not isinstance(auth, dict):
        errs.append(f"{where}: x-sixkey-auth missing")
        return
    need(
        auth.get("signer") in SIGNERS and auth.get("account_session") in ACCOUNT and auth.get("pw_auth") in PW,
        f"{where}: x-sixkey-auth values",
    )
    sec = sorted(sorted(r) for r in op.get("security", []))
    expect = {
        ("none", "none"): [],
        ("none", "required"): [["accountSession"]],
        ("registration", "required"): [["accountSession", "registrationSignature"]],
        ("device", "none"): [["deviceSignature"]],
        ("device", "step_up"): [["accountSession", "deviceSignature"]],
        ("enroll", "none"): [["enrollSignature"]],
        ("device_or_enroll", "none"): [["deviceSignature"], ["enrollSignature"]],
    }.get((auth["signer"], auth["account_session"]))
    need(expect is not None and sec == sorted(expect), f"{where}: security {sec} does not match x-sixkey-auth")
    if auth["signer"] != "none":
        need(
            ("header", "Sixkey-Ts") in names and ("header", "Sixkey-Sig") in names,
            f"{where}: signed but no Sixkey-Ts/Sixkey-Sig",
        )
        if auth["signer"] in ("device", "registration"):
            need(("header", "Sixkey-Device") in names, f"{where}: needs Sixkey-Device")
        if auth["signer"] == "enroll":
            need(("header", "Sixkey-Enroll") in names, f"{where}: needs Sixkey-Enroll")
        if auth["signer"] == "device_or_enroll":
            need(
                ("header", "Sixkey-Device") in names and ("header", "Sixkey-Enroll") in names,
                f"{where}: needs both signer headers",
            )
    rs = request_schema(op)
    props, req = schema_props(o, rs) if rs is not None else (set(), set())
    pw = auth["pw_auth"]
    if pw == "required":
        need("password_auth" in req, f"{where}: pw_auth required but password_auth not required")
    elif pw == "none":
        need("password_auth" not in props, f"{where}: password_auth present but pw_auth none")
    elif pw == "device_only":
        need("password_auth" in props and "password_auth" not in req, f"{where}: password_auth must be optional")
    elif pw == "password_or_recovery":
        s = deref(o, rs)
        need(
            {"password_auth", "recovery_auth"} <= props and "oneOf" in s,
            f"{where}: needs password_auth | recovery_auth (oneOf)",
        )
    need(("write_proof" in req) == bool(auth.get("write_proof")), f"{where}: write_proof flag vs request schema")
    has_new_sig = any(p["in"] == "header" and p["name"] == "Sixkey-New-Sig" and p.get("required") for p in params)
    need(
        has_new_sig == bool(auth.get("new_key_proof")),
        f"{where}: new_key_proof flag vs the required Sixkey-New-Sig header",
    )
    need("new_sig" not in props, f"{where}: new_sig must not be a body member (it is the Sixkey-New-Sig header)")
    if rs is not None:
        lim = op.get("x-sixkey-max-body-bytes")
        want = vault_limit if "envelope" in props else other_limit
        need(lim == want, f"{where}: x-sixkey-max-body-bytes {lim} should be {want}")
    responses = op.get("responses", {})
    need("423" not in responses, f"{where}: 423 is removed")
    errmap = op.get("x-sixkey-errors")
    if not isinstance(errmap, dict):
        errs.append(f"{where}: x-sixkey-errors missing")
        return
    need(
        "too_large" in errmap.get("413", []),
        f"{where}: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)",
    )
    for status, lst in errmap.items():
        need(status in responses, f"{where}: x-sixkey-errors status {status} has no response")
        for c in lst:
            need(c in table, f"{where}: unknown error code {c}")
            if c in table:
                need(str(table[c]["status"]) == status, f"{where}: {c} is {table[c]['status']}, listed under {status}")
                used.add(c)
    for status, resp in responses.items():
        if status[0] in "45":
            need(bool(errmap.get(status)), f"{where}: error response {status} lists no codes")
        elif status[0] == "2":
            r = deref(o, resp)
            content = r.get("content")
            if status == "204":
                need(content is None, f"{where}: 204 must have no body")
            else:
                need(
                    content is not None and requires_server_time(o, content["application/json"]["schema"]),
                    f"{where}: {status} body must require server_time",
                )
        elif status == "304":
            need(deref(o, resp).get("content") is None, f"{where}: 304 must have no body")


def _check_removed(o: Any, codes: list, table: dict, errs: list) -> None:
    def need(cond: bool, msg: str) -> None:
        if not cond:
            errs.append(msg)

    removed = o["x-sixkey-removed"]
    present = {f"{m} {p}" for m, p, _ in operations(o)}
    for r in removed["operations"]:
        need(r not in present, f"removed operation present: {r}")
    for p in o["paths"]:
        for sub in removed["path_substrings"]:
            need(sub not in p, f"removed path fragment {sub!r} in {p}")
    for c in removed["error_codes"]:
        need(c not in codes and c not in table, f"removed error code present: {c}")

    def no_removed(node: Any, path: str) -> None:
        if path.startswith("#/x-sixkey-removed"):
            return
        if isinstance(node, dict):
            if node.get("in") == "header" and node.get("name") in removed["headers"]:
                errs.append(f"{path}: removed header {node['name']}")
            for k in node:
                if k in removed["statuses"] and path.endswith("/responses"):
                    errs.append(f"{path}: removed status {k}")
                if k in removed["headers"] and path.endswith("/headers"):
                    errs.append(f"{path}: removed header {k}")
            props = node.get("properties")
            if isinstance(props, dict):
                for f in removed["fields"]:
                    if f in props:
                        errs.append(f"{path}: removed field {f}")

    walk(o, no_removed)


def find_operation(o: Any, operation: str) -> dict:
    method, path = operation.split(" ", 1)
    return o["paths"][path][method.lower()]


def wire_example_errors(o: Any, ex: dict) -> list[str]:
    op = find_operation(o, ex["operation"])
    if ex["kind"] == "request":
        schema = request_schema(op)
    else:
        resp = deref(o, op["responses"][ex["status"]])
        schema = resp["content"]["application/json"]["schema"]
    return validate(schema, ex["body"], o, f"{ex['operation']} {ex['kind']}")


# ------------------------------------------------------------------------------------------------ stdlib primitives


def sha256(*parts: bytes) -> bytes:
    return hashlib.sha256(b"".join(parts)).digest()


def hmac256(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf(ikm: bytes, salt: bytes, info: str, length: int) -> bytes:
    """RFC 5869 with SHA-256. An empty salt is HMAC's zero-padded empty key, as in WebCrypto."""
    prk = hmac256(salt, ikm)
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac256(prk, t + info.encode() + bytes([i]))
        okm += t
        i += 1
    return okm[:length]


def pbkdf2(password: bytes, salt: bytes, iterations: int, length: int = 32) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password, salt, iterations, length)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")
B64U_RE = re.compile(r"[A-Za-z0-9_-]*\Z")


def from_b64(s: str) -> bytes:
    """Phase 0 fromB64 rules: length % 4 == 0, strict alphabet, padding only at the end."""
    if not isinstance(s, str) or len(s) % 4 != 0 or not B64_RE.match(s):
        raise ValueError("bad base64")
    return base64.b64decode(s, validate=True)


def from_b64u(s: str) -> bytes:
    """Strict base64url: no padding, no other characters, len % 4 != 1, canonical trailing bits."""
    if not isinstance(s, str) or not B64U_RE.match(s) or len(s) % 4 == 1:
        raise ValueError("bad base64url")
    b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    if b64u(b) != s:
        raise ValueError("non-canonical base64url")
    return b


def js_string(s: str) -> str:
    """JSON.stringify for a string (ES2019 well-formed): short escapes, \\u00xx lowercase, lone surrogates escaped."""
    out = ['"']
    short = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
    for ch in s:
        o = ord(ch)
        if ch in short:
            out.append(short[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical_json(v: Any) -> str:
    """Phase 0 canonicalJson: keys sorted by UTF-16 code units. Only safe integers, as the contract requires."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        check(abs(v) <= 2**53 - 1, "canonicalJson: integer outside the safe range")
        return str(v)
    if isinstance(v, float):
        raise Fail("canonicalJson: non-integer numbers are not cross-language stable")
    if isinstance(v, str):
        return js_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(js_string(k) + ":" + canonical_json(v[k]) for k in keys) + "}"
    raise Fail(f"canonicalJson: unsupported {type(v).__name__}")


def trunc(ms: int, unit: int) -> int:
    return ms // unit * unit


def six_digits(prefix: str, h: bytes) -> tuple[int, str]:
    u32 = int.from_bytes(sha256(prefix.encode(), h)[:4], "big")
    return u32, f"{u32 % 1_000_000:06d}"


CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
# The 28-symbol codes (recovery code, pairing code): the check bits are the first 12 bits of SHA-256(tag || secret).
# The recovery code's tag is empty (Phase 0); the pairing code's is PAIRING_TAG (§3.2 MUST 10, revision 27).
PAIRING_TAG = "sixkey-pairing-code|1|"
ENROLL_KEY_INFO = "sixkey/v2/enroll-key"  # K = HKDF(Z || S, h, this) (enrolment v2, revision 27)
SAS_TAG = "sixkey/v2/enroll-sas|"


def code_check_bits(secret: bytes, tag: str = "") -> int:
    h = sha256(tag.encode(), secret)
    return (h[0] << 4) | (h[1] >> 4)


def code_format(secret: bytes, tag: str = "") -> str:
    if len(secret) != 16:
        raise ValueError("a 28-symbol code holds 16 bytes")
    n = (int.from_bytes(secret, "big") << 12) | code_check_bits(secret, tag)
    s = ""
    for _ in range(28):
        s = CROCKFORD[n & 31] + s
        n >>= 5
    return "-".join(s[i : i + 4] for i in range(0, 28, 4))


def code_parse(text: str, tag: str = "", kind: str = "recovery") -> bytes:
    s = re.sub(r"[\s\-_]", "", text.upper()).replace("O", "0").replace("I", "1").replace("L", "1")
    if len(s) != 28:
        raise ValueError(f"{kind}_length")
    n = 0
    for ch in s:
        v = CROCKFORD.find(ch)
        if v < 0:
            raise ValueError(f"{kind}_char")
        n = (n << 5) | v
    secret = (n >> 12).to_bytes(16, "big")
    if code_check_bits(secret, tag) != n & 0xFFF:
        raise ValueError(f"{kind}_checksum")
    return secret


def recovery_check_bits(secret: bytes) -> int:
    return code_check_bits(secret, "")


def recovery_format(secret: bytes) -> str:
    return code_format(secret, "")


def recovery_parse(text: str) -> bytes:
    return code_parse(text, "", "recovery")


def pairing_format(secret: bytes) -> str:
    return code_format(secret, PAIRING_TAG)


def pairing_parse(text: str) -> bytes:
    return code_parse(text, PAIRING_TAG, "pairing")


def kdf_params_ok(p: Any) -> bool:
    """Phase 0 assertKdfParams for PBKDF2 (core/crypto/kdf.ts)."""
    try:
        if (
            not isinstance(p, dict)
            or p.get("v") != 1
            or p.get("hash") != "SHA-256"
            or not isinstance(p.get("salt"), str)
        ):
            return False
        if len(from_b64(p["salt"])) < 16 or p.get("name") != "PBKDF2":
            return False
        it = p.get("iterations")
        return isinstance(it, int) and not isinstance(it, bool) and 600_000 <= it <= 20_000_000
    except ValueError:
        return False


BIDI_CONTROL = {0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)}
ZERO_WIDTH = {0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF}


def device_name_rule(s: str) -> dict:
    """§2.4 (revision 5, §0.0d N5): NFKC, trim U+0020 at both ends, then reject in a fixed order."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        return {"valid": False, "reason": "not_well_formed"}
    n = unicodedata.normalize("NFKC", s).strip(" ")
    cps = len(n)
    if cps < 1:
        return {"valid": False, "reason": "empty", "normalized": n}
    if cps > 40:
        return {"valid": False, "reason": "too_long", "normalized": n, "code_points": cps}
    if any(unicodedata.category(c) == "Cc" for c in n):
        return {"valid": False, "reason": "control_char", "normalized": n}
    if any(ord(c) in BIDI_CONTROL for c in n):
        return {"valid": False, "reason": "bidi_control", "normalized": n}
    if any(ord(c) in ZERO_WIDTH for c in n):
        return {"valid": False, "reason": "zero_width", "normalized": n}
    b = n.encode("utf-8")
    padded = b + b" " * (160 - len(b))
    return {
        "valid": True,
        "normalized": n,
        "code_points": cps,
        "utf16_units": len(n.encode("utf-16-le")) // 2,
        "utf8_len": len(b),
        "padded_b64": b64(padded),
        "decoded": padded.decode("utf-8").rstrip(" "),
    }


def integer_tokens_only(text: str) -> bool:
    """§2.3, §5.4 (§0.0d N20): every number token is an integer literal with |n| <= 2^53 - 1 (strict parse)."""

    def no_float(tok: str) -> Any:
        raise ValueError(f"non-integer number token {tok}")

    def safe_int(tok: str) -> int:
        v = int(tok)
        if abs(v) > 2**53 - 1:
            raise ValueError("integer outside the safe range")
        return v

    def no_constant(tok: str) -> Any:
        raise ValueError(f"constant {tok}")

    try:
        json.loads(text, parse_float=no_float, parse_int=safe_int, parse_constant=no_constant)
        return True
    except ValueError:
        return False


# ------------------------------------------------------------------------------------------------ pure-Python P-256

P = 2**256 - 2**224 + 2**192 + 2**96 - 1
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)
SPKI_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")


def on_curve(pt: tuple[int, int]) -> bool:
    x, y = pt
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


def ec_add(p1: Any, p2: Any) -> Any:
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def ec_mul(k: int, pt: Any) -> Any:
    r = None
    for bit in bin(k)[2:]:
        r = ec_add(r, r)
        if bit == "1":
            r = ec_add(r, pt)
    return r


def point_raw(pt: tuple[int, int]) -> bytes:
    return b"\x04" + pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")


def epk_point(raw: bytes) -> tuple[int, int]:
    """§2.2: epk is exactly the 65-byte uncompressed point, on the curve."""
    if len(raw) != 65 or raw[0] != 4:
        raise ValueError("epk must be a 65-byte uncompressed point")
    pt = (int.from_bytes(raw[1:33], "big"), int.from_bytes(raw[33:], "big"))
    if not on_curve(pt):
        raise ValueError("point not on P-256")
    return pt


def dpk_point(spki: bytes) -> tuple[int, int]:
    """§2.2: dpk is exactly 91-byte SPKI DER (id-ecPublicKey, prime256v1) of an uncompressed point."""
    if len(spki) != 91 or spki[:26] != SPKI_P256_PREFIX:
        raise ValueError("dpk must be P-256 SPKI DER with an uncompressed point")
    return epk_point(spki[26:])


def ecdh_x(d: int, peer: tuple[int, int]) -> bytes:
    z = ec_mul(d, peer)
    check(z is not None, "ECDH at infinity")
    return z[0].to_bytes(32, "big")


def p1363_ok(sig: bytes) -> bool:
    if len(sig) != 64:
        return False
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    return 0 < r < N and 0 < s < N


def ecdsa_verify(pub: tuple[int, int], msg: bytes, sig: bytes) -> bool:
    if not p1363_ok(sig):
        return False
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    e = int.from_bytes(sha256(msg), "big")
    w = pow(s, -1, N)
    x = ec_add(ec_mul(e * w % N, G), ec_mul(r * w % N, pub))
    return x is not None and x[0] % N == r


def der_int(b: bytes) -> bytes:
    b = b.lstrip(b"\x00") or b"\x00"
    if b[0] & 0x80:
        b = b"\x00" + b
    return bytes([0x02, len(b)]) + b


def p1363_to_der(sig: bytes) -> bytes:
    check(len(sig) == 64, "P1363 signature must be 64 bytes")
    body = der_int(sig[:32]) + der_int(sig[32:])
    return bytes([0x30, len(body)]) + body


def signing_input(c: dict) -> str:
    for k in ("host", "method", "target", "signer", "sub"):
        if "|" in c[k]:
            raise ValueError(f"'|' in {k}")
    if not c["target"].startswith("/"):
        raise ValueError("target must start with /")
    if not re.fullmatch(r"[A-Z]+", c["method"]):
        raise ValueError("method must be uppercase")
    if not re.fullmatch(r"[0-9]+", str(c["ts"])):
        raise ValueError("ts must be decimal")
    return f"sixkey-req|1|{c['host']}|{c['method']}|{c['target']}|{c['signer']}|{c['sub']}|{c['ts']}|{c['body_sha256_b64u']}"


# ------------------------------------------------------------------------------------------------ optional AES-GCM etc.


def gcm_encrypt(key: bytes, iv: bytes, pt: bytes, aad: bytes) -> bytes:
    return AESGCM(key).encrypt(iv, pt, aad)


def gcm_opens(key: bytes, iv: bytes, ct: bytes, aad: bytes) -> bool:
    try:
        AESGCM(key).decrypt(iv, ct, aad)
        return True
    except InvalidTag:
        return False


# ------------------------------------------------------------------------------------------------ vector verification
# Each verifier returns {"python-stdlib": "ok", "python-cryptography": "ok" | "skipped: ..." | "n/a"} or raises Fail.

CRYPTO_SKIP = "skipped: pyca/cryptography is not importable (AES-GCM is not in the standard library)"


def _crypto(fn: Callable[[], None]) -> str:
    if not HAVE_CRYPTOGRAPHY:
        return CRYPTO_SKIP
    fn()
    return "ok"


def v_labels(g: dict, V: dict) -> dict:
    labels = [x["label"] for x in g["hkdf_info"]]
    tags = [x["tag"] for x in g["domain_tags"]]
    check(len(set(labels)) == len(labels), "HKDF labels are not pairwise distinct")
    check(len(set(labels + tags)) == len(labels) + len(tags), "labels and domain tags are not globally distinct")
    for a in tags:
        for b in tags:
            check(a == b or not b.startswith(a), f"domain tag {a!r} is a prefix of {b!r}")
    check(all(g["assertions"].values()), "assertions must all be true")
    used = {s["label"] for k in V["groups"]["vk_subkeys"]["keys"] for s in k["subkeys"]}
    used |= {"sixkey/v1/recovery-auth", "sixkey/v1/password-auth", ENROLL_KEY_INFO, "sixkey/v1/kek-recovery"}
    check(PAIRING_TAG in tags and SAS_TAG in tags, "the pairing-code and SAS tags are listed")
    check(
        not any(re.match(r"sixkey(-enroll(-commit|-name|-payload)?\|1\||/v1/enroll-)", x) for x in labels + tags),
        "no version-1 enrolment label or tag is listed (revision 27)",
    )
    check(used <= set(labels), f"labels used by other groups but not listed: {sorted(used - set(labels))}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_base64url(g: dict, V: dict) -> dict:
    for c in g["encode"]:
        check(b64u(bytes.fromhex(c["hex"])) == c["b64u"], f"b64u encode {c['hex']}")
        check(from_b64u(c["b64u"]).hex() == c["hex"], f"b64u decode {c['b64u']}")
    for c in g["decode_reject"]:
        try:
            from_b64u(c["input"])
        except ValueError:
            continue
        raise Fail(f"b64u must reject {c['input']!r} ({c['why']})")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_base64(g: dict, V: dict) -> dict:
    for c in g["encode"]:
        check(b64(bytes.fromhex(c["hex"])) == c["b64"], f"b64 encode {c['hex']}")
        check(from_b64(c["b64"]).hex() == c["hex"], f"b64 decode {c['b64']}")
    for c in g["decode_reject"]:
        try:
            from_b64(c["input"])
        except ValueError:
            continue
        raise Fail(f"b64 must reject {c['input']!r}")
    for c in g["decode_accept_noncanonical"]:
        check(from_b64(c["input"]).hex() == c["hex"], f"b64 lenient {c['input']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_canonical_json(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        check(canonical_json(json.loads(c["input"])) == c["canonical"], f"canonicalJson: {c['name']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_time(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        ms = c["ms"]
        check(
            (trunc(ms, 3_600_000), trunc(ms, 86_400_000), trunc(ms, 60_000), ms % 3_600_000 == 0)
            == (c["hour"], c["day"], c["minute"], c["hour_aligned"]),
            f"truncation of {ms}",
        )
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_padding(g: dict, V: dict) -> dict:
    bucket = g["bucket_bytes"]
    for c in g["lengths"]:
        check(-(-c["utf8_len"] // bucket) * bucket == c["padded_len"], f"padding of {c['utf8_len']}")
    for c in g["concrete"]:
        b = c["plaintext"].encode()
        padded = b + b" " * (-(-len(b) // bucket) * bucket - len(b))
        check(len(b) == c["utf8_len"] and len(padded) == c["padded_len"], "padded length")
        check(b64(sha256(padded)) == c["padded_sha256_b64"], "padded bytes")
        check(json.loads(padded.decode()) == json.loads(c["plaintext"]), "JSON parse ignores the padding")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_vk_subkeys(g: dict, V: dict) -> dict:
    for k in g["keys"]:
        vk = bytes.fromhex(k["vk_hex"])
        check(hkdf(vk, b"", "sixkey/v1/vk-id", 8).hex() == k["vk_id"], f"{k['vk']} vkId")
        seen = set()
        for s in k["subkeys"]:
            got = hkdf(vk, b"", s["label"], s["bits"] // 8).hex()
            check(got == s["hex"], f"{k['vk']} {s['label']}")
            seen.add(got)
        check(len(seen) == len(k["subkeys"]), f"{k['vk']} subkeys are not distinct")
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    for c in g["webcrypto_hazard"]["cases"]:
        bits = hkdf(vk1, b"", c["label"], 32).hex()
        check(bits == c["derive_bits_256_hex"] == c["derive_key_aes256_export_hex"], f"hazard {c['label']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def k_enc(vk: bytes) -> bytes:
    return hkdf(vk, b"", "sixkey/v1/vault-enc", 32)


def v_envelope(g: dict, V: dict) -> dict:
    e = g["envelope"]
    aad = f"sixkey-vault|1|{e['vaultId']}|{e['vkId']}|{e['rev']}"
    check(aad == g["aad"], "envelope AAD")
    iv, ct = from_b64(e["iv"]), from_b64(e["ciphertext"])
    check(b64(sha256(aad.encode(), iv, ct)) == e["checksum"] == g["checksum_b64"], "envelope checksum")
    check(
        json.dumps(e, separators=(",", ":"), ensure_ascii=False) == g["envelope_text"],
        "envelope text is JSON.stringify",
    )
    check(b64(sha256(g["envelope_text"].encode())) == g["head_b64"], "head")
    r = g["head_of_reserialized_text"]
    check(b64(sha256(r["envelope_text"].encode())) == r["head_b64"] != g["head_b64"], "reserialized head differs")
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    check(hkdf(vk1, b"", "sixkey/v1/vk-id", 8).hex() == e["vkId"], "envelope vkId")

    def crypto() -> None:
        check(gcm_encrypt(k_enc(vk1), iv, g["plaintext"].encode(), aad.encode()) == ct, "envelope AES-GCM")
        for m in g["must_not_open"]:
            check(
                not gcm_opens(k_enc(vk1), from_b64(m["iv_b64"]), from_b64(m["ciphertext_b64"]), m["aad"].encode()),
                f"envelope must not open: {m['name']}",
            )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_write_proof(g: dict, V: dict) -> dict:
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    vk2 = bytes.fromhex(V["fixed_inputs"]["vk2_hex"])
    kw = hkdf(vk1, b"", "sixkey/v1/vault-write", 32)
    check(b64(kw) == g["write_key_b64"], "K_write")
    check(b64(hkdf(vk2, b"", "sixkey/v1/vault-write", 32)) == g["new_write_key_b64_vk2"], "K_write of VK2")
    check(kw != k_enc(vk1), "K_write must differ from K_enc")
    check(g["if_version"] + 1 == g["envelope_rev"], "envelope.rev = if_version + 1")
    inp = f"sixkey-write|1|{g['vault_id']}|{g['if_version']}|{g['checksum_b64']}"
    check(inp == g["input"], "write-proof input")
    check(b64(hmac256(kw, inp.encode())) == g["write_proof_b64"], "write proof")
    for c in g["verify"]:
        expected = b64(hmac256(kw, f"sixkey-write|1|{c['vault_id']}|{c['if_version']}|{c['checksum_b64']}".encode()))
        check(hmac.compare_digest(expected, c["proof_b64"]) == c["valid"], f"write proof verify: {c['name']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_recovery_auth(g: dict, V: dict) -> dict:
    secret = bytes.fromhex(g["secret_hex"])
    check(recovery_format(secret) == g["code"], "recovery code text")
    check(recovery_parse(g["code"]) == secret, "recovery code parse")
    for s in g["equivalent_inputs"]:
        check(recovery_parse(s) == secret, f"equivalent input {s!r}")
    for r in g["rejected_inputs"]:
        try:
            recovery_parse(r["input"])
        except ValueError as e:
            check(str(e) == r["error"], f"{r['input']!r}: {e} != {r['error']}")
            continue
        raise Fail(f"recovery code must be rejected: {r['input']!r}")
    rec_auth = hkdf(secret, b"", "sixkey/v1/recovery-auth", 32)
    check(b64(rec_auth) == g["recovery_auth_b64"], "recAuth")
    verifier = sha256(b"sixkey-recovery-verifier|1|", rec_auth)
    check(b64(verifier) == g["recovery_verifier_b64"], "recovery verifier")
    c = g["contrast"]
    salt = from_b64(c["kek_recovery_salt_b64"])
    check(hkdf(secret, salt, "sixkey/v1/kek-recovery", 32).hex() == c["kek_recovery_hex"], "recovery KEK")
    check(
        b64(hkdf(secret, salt, "sixkey/v1/recovery-auth", 32)) == c["recovery_auth_with_wrap_salt_b64"],
        "recAuth with salt",
    )
    check(
        b64(sha256(f"sixkey-recovery-verifier|1|{b64(rec_auth)}".encode())) == c["verifier_over_base64_text_b64"],
        "verifier over text",
    )
    check(len({c["kek_recovery_hex"], rec_auth.hex()}) == 2, "recAuth must differ from the KEK")
    check(
        c["recovery_auth_with_wrap_salt_b64"] != g["recovery_auth_b64"]
        and c["verifier_over_base64_text_b64"] != g["recovery_verifier_b64"],
        "contrast values must differ",
    )
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_password_auth(g: dict, V: dict) -> dict:
    kdf = g["kdf"]
    check(kdf_params_ok(kdf), "auth kdf parameters")
    salt = from_b64(kdf["salt"])
    results = {}
    for c in g["cases"]:
        n = unicodedata.normalize("NFKC", c["password"])
        check(n == c["nfkc"], f"NFKC {c['name']}")
        pb = pbkdf2(n.encode(), salt, kdf["iterations"])
        check(pb.hex() == c["pbkdf2_hex"], f"PBKDF2 {c['name']}")
        pw_auth = hkdf(pb, b"", "sixkey/v1/password-auth", 32)
        check(b64(pw_auth) == c["password_auth_b64"], f"pw_auth {c['name']}")
        check(
            b64(sha256(b"sixkey-password-verifier|1|", pw_auth)) == c["password_verifier_b64"], f"verifier {c['name']}"
        )
        results[c["name"]] = c["password_auth_b64"]
    check(len(set(results.values())) == len(results) - 1, "exactly the NFKC-equal pair must share pw_auth")
    for p in g["kdf_params"]["accept"]:
        check(kdf_params_ok(p), f"kdf params should be accepted: {p}")
    for p in g["kdf_params"]["reject"]:
        check(not kdf_params_ok(p), f"kdf params should be rejected: {p}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


DEVICE_ID_RE = re.compile(r"[A-Za-z0-9_-]{22}\Z")
VAULT_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
VK_ID_RE = re.compile(r"[0-9a-f]{16}\Z")


def bundle_shape_ok(b: Any) -> bool:
    """The explicit rules of §2.3/§3.13 (keyless; what M1 and the server must enforce on a sync bundle)."""
    try:
        if not isinstance(b, dict) or b.get("format") != "sixkey-keybundle" or b.get("v") != 1:
            return False
        kr = b.get("keyring")
        if not isinstance(b.get("vaultId"), str) or not VAULT_ID_RE.match(b["vaultId"]) or not isinstance(kr, dict):
            return False
        kv = b.get("kver")
        if not isinstance(kv, int) or isinstance(kv, bool) or kv < 1:
            return False
        if kr.get("format") != "sixkey-keyring" or kr.get("v") != 1 or kr.get("vaultId") != b["vaultId"]:
            return False
        if not isinstance(kr.get("vkId"), str) or not VK_ID_RE.match(kr["vkId"]) or "deviceKey" in kr:
            return False
        wraps = kr.get("wraps")
        if (
            not isinstance(wraps, list)
            or len(wraps) != 2
            or sorted(w.get("method") for w in wraps) != ["password", "recovery"]
        ):
            return False
        for w in wraps:
            if w.get("vkId") != kr["vkId"] or len(from_b64(w["iv"])) != 12 or len(from_b64(w["wrapped"])) != 48:
                return False
            if w["method"] == "password" and not kdf_params_ok(w.get("kdf")):
                return False
            if w["method"] == "recovery" and (
                w.get("kdf", {}).get("name") != "HKDF" or len(from_b64(w["kdf"]["salt"])) < 16
            ):
                return False
        prev = kr.get("previous")
        if not isinstance(prev, list) or len(prev) > 64:
            return False
        times = [b.get("at")] + [w.get("createdAt") for w in wraps] + [x.get("createdAt") for x in prev]
        if not all(isinstance(x, int) and not isinstance(x, bool) and x % 3_600_000 == 0 for x in times):
            return False  # §2.3 (§0.0d N16): the server rejects bundle times that are not whole UTC hours
        if not kdf_params_ok(b.get("auth", {}).get("kdf")):
            return False
        if not isinstance(b.get("by"), str) or not DEVICE_ID_RE.match(b["by"]):
            return False
        return isinstance(b.get("at"), int) and len(from_b64(b.get("mac", ""))) == 32
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def bundle_mac(bundle: dict, k_mac: bytes) -> str:
    rest = {k: v for k, v in bundle.items() if k != "mac"}
    return b64(hmac256(k_mac, ("sixkey-keybundle|1|" + canonical_json(rest)).encode()))


def v_keybundle(g: dict, V: dict) -> dict:
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    k_mac = hkdf(vk1, b"", "sixkey/v1/keybundle-mac", 32)
    check(k_mac.hex() == g["k_mac_hex"], "K_mac")
    bundle = json.loads(g["raw"])
    check(json_equal(bundle, g["bundle"]), "raw parses to the bundle object")
    rest = {k: v for k, v in bundle.items() if k != "mac"}
    check("sixkey-keybundle|1|" + canonical_json(rest) == g["mac_input"], "MAC input")
    check(bundle_mac(bundle, k_mac) == g["mac_b64"] == bundle["mac"], "MAC")
    k512 = hkdf(vk1, b"", "sixkey/v1/keybundle-mac", 64)
    for c in g["mac_cases"]:
        b = json.loads(c["raw"])
        ok = hmac.compare_digest(bundle_mac(b, k_mac), b.get("mac", ""))
        check(ok == c["mac_valid"], f"MAC case: {c['name']}")
        if "512-bit" in c["name"]:
            check(bundle_mac(b, k512) == b["mac"], "the 512-bit case is HMAC with HKDF(..., 512 bits)")
    for c in g["shape_cases"]:
        b = json.loads(c["raw"])
        check(bundle_mac(b, k_mac) == b["mac"], f"shape case MAC: {c['name']}")
        check(bundle_shape_ok(b) == c["shape_valid"], f"shape case: {c['name']}")
    kr = bundle["keyring"]
    vk_id, vault_id = kr["vkId"], kr["vaultId"]
    pw_w = next(w for w in kr["wraps"] if w["method"] == "password")
    rc_w = next(w for w in kr["wraps"] if w["method"] == "recovery")
    prev = kr["previous"][0]
    check(
        g["aad"]["password"]
        == f"sixkey-wrap|1|password|{vk_id}|{vault_id}|PBKDF2-SHA256:{pw_w['kdf']['iterations']}:{pw_w['kdf']['salt']}",
        "password wrap AAD",
    )
    check(
        g["aad"]["recovery"] == f"sixkey-wrap|1|recovery|{vk_id}|{vault_id}|HKDF-SHA256:{rc_w['kdf']['salt']}",
        "recovery wrap AAD",
    )
    check(g["aad"]["previous"] == f"sixkey-prev|1|{vault_id}|{vk_id}|{prev['vkId']}", "previous AAD")
    kek_pw = pbkdf2(
        unicodedata.normalize("NFKC", g["password"]).encode(), from_b64(pw_w["kdf"]["salt"]), pw_w["kdf"]["iterations"]
    )
    kek_rc = hkdf(bytes.fromhex(g["recovery_secret_hex"]), from_b64(rc_w["kdf"]["salt"]), "sixkey/v1/kek-recovery", 32)
    kek_pv = hkdf(vk1, b"", "sixkey/v1/kek-previous", 32)
    check(
        (kek_pw.hex(), kek_rc.hex(), kek_pv.hex())
        == (g["kek_hex"]["password"], g["kek_hex"]["recovery"], g["kek_hex"]["previous"]),
        "KEKs",
    )
    check(
        from_b64(bundle["auth"]["kdf"]["salt"]) != from_b64(pw_w["kdf"]["salt"]),
        "auth salt differs from the wrap salt (§2.3)",
    )
    for t in [bundle["at"]] + [w["createdAt"] for w in kr["wraps"]] + [p["createdAt"] for p in kr["previous"]]:
        check(t % 3_600_000 == 0, "bundle times are truncated to the hour (T1)")

    def crypto() -> None:
        vk0 = bytes.fromhex(g["vk0_hex"])
        check(
            AESGCM(kek_pw).decrypt(from_b64(pw_w["iv"]), from_b64(pw_w["wrapped"]), g["aad"]["password"].encode())
            == vk1,
            "password wrap opens to VK1",
        )
        check(
            AESGCM(kek_rc).decrypt(from_b64(rc_w["iv"]), from_b64(rc_w["wrapped"]), g["aad"]["recovery"].encode())
            == vk1,
            "recovery wrap opens to VK1",
        )
        check(
            AESGCM(kek_pv).decrypt(from_b64(prev["iv"]), from_b64(prev["wrapped"]), g["aad"]["previous"].encode())
            == vk0,
            "previous opens to VK0",
        )
        check(hkdf(vk0, b"", "sixkey/v1/vk-id", 8).hex() == prev["vkId"], "previous vkId")

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_device_name(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        got = device_name_rule(c["input"])
        want = {k: v for k, v in c.items() if k not in ("name", "input")}
        check(got == want, f"device name {c['name']}: {got} != {want}")
    e = g["encrypt"]
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    vk2 = bytes.fromhex(V["fixed_inputs"]["vk2_hex"])
    k_name = hkdf(vk1, b"", "sixkey/v1/device-name", 32)
    check(k_name.hex() == e["k_name_hex"], "K_name")
    vault_id = V["fixed_inputs"]["vault_id"]
    for c in e["cases"]:
        nc = c["name_ct"]
        check(c["aad"] == f"sixkey-devname|1|{vault_id}|{nc['vkId']}|{c['device_id']}", "devname AAD")
        check(len(from_b64(nc["ct"])) == 176, "name ciphertext is 176 bytes")

    def crypto() -> None:
        for c in e["cases"]:
            nc = c["name_ct"]
            padded = from_b64(device_name_rule(c["name"])["padded_b64"])
            check(
                gcm_encrypt(k_name, from_b64(nc["iv"]), padded, c["aad"].encode()) == from_b64(nc["ct"]),
                f"name_ct {c['device_id']}",
            )
        for m in e["must_not_open"]:
            key = k_name if m["key"] == "VK1" else hkdf(vk2, b"", "sixkey/v1/device-name", 32)
            check(
                not gcm_opens(key, from_b64(m["iv_b64"]), from_b64(m["ct_b64"]), m["aad"].encode()),
                f"must not open: {m['name']}",
            )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_device_backup(g: dict, V: dict) -> dict:
    vk1 = bytes.fromhex(V["fixed_inputs"]["vk1_hex"])
    enc = g["enc"]
    check(g["aad"] == f"sixkey-devkey|1|{V['fixed_inputs']['vault_id']}|{enc['vkId']}|{g['device_id']}", "devkey AAD")
    check(canonical_json(json.loads(g["plaintext"])) == g["plaintext"], "plaintext is canonical JSON")
    check(V["fixed_inputs"]["email"] in g["plaintext"], "email inside the encrypted copy only (d7)")

    def crypto() -> None:
        k = hkdf(vk1, b"", "sixkey/v1/device-backup", 32)
        check(
            gcm_encrypt(k, from_b64(enc["iv"]), g["plaintext"].encode(), g["aad"].encode()) == from_b64(enc["ct"]),
            "device backup AES-GCM",
        )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def keys_by_name(V: dict) -> dict:
    return {k["name"]: k for k in V["groups"]["public_keys"]["keys"]}


def v_public_keys(g: dict, V: dict) -> dict:
    check(bytes.fromhex(g["spki_p256_prefix_hex"]) == SPKI_P256_PREFIX, "SPKI prefix")
    for k in g["keys"]:
        d = int(k["d_hex"], 16)
        pt = ec_mul(d, G)
        check(pt == (int(k["x_hex"], 16), int(k["y_hex"], 16)), f"{k['name']}: d*G")
        raw = point_raw(pt)
        check(b64(raw) == k["point_b64"] and b64u(raw) == k["point_b64u"], f"{k['name']}: point encoding")
        check(
            b64(SPKI_P256_PREFIX + raw) == k["spki_b64"] and b64u(SPKI_P256_PREFIX + raw) == k["spki_b64u"],
            f"{k['name']}: SPKI",
        )
        check(
            dpk_point(from_b64(k["spki_b64"])) == pt and epk_point(raw) == pt,
            f"{k['name']}: accepted by the format checks",
        )
    for r in g["epk_reject"]:
        try:
            epk_point(from_b64(r["b64"]))
        except ValueError:
            continue
        raise Fail(f"epk must be rejected: {r['name']}")
    for r in g["dpk_reject"]:
        try:
            dpk_point(from_b64(r["b64"]))
        except ValueError:
            continue
        raise Fail(f"dpk must be rejected: {r['name']}")

    def crypto() -> None:
        for k in g["keys"]:
            priv = ec.derive_private_key(int(k["d_hex"], 16), ec.SECP256R1())
            spki = priv.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            check(b64(spki) == k["spki_b64"], f"{k['name']}: pyca SPKI")

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def commit_of(dev_n: str, dpk: bytes, epk: bytes, n: bytes) -> bytes:
    return sha256(f"sixkey-enroll-commit|2|{dev_n}|{b64u(dpk)}|{b64u(epk)}|{b64u(n)}".encode())


def transcript_of(t: dict) -> str:
    return f"sixkey-enroll|2|{t['rid']}|{t['devN']}|{t['devA']}|{b64u(t['dpkN'])}|{b64u(t['epkN'])}|{b64u(t['epkA'])}|{b64u(t['nN'])}"


def enroll_key(z: bytes, s: bytes, h: bytes) -> bytes:
    """K = HKDF(IKM = Z || S, salt = h, 'sixkey/v2/enroll-key', 256) (§3.2 M3, revision 27)."""
    check(len(z) == 32 and len(s) == 16 and len(h) == 32, "enrolment key inputs")
    return hkdf(z + s, h, ENROLL_KEY_INFO, 32)


def v_enrollment(g: dict, V: dict) -> dict:
    keys = keys_by_name(V)
    i = g["inputs"]
    fi = V["fixed_inputs"]
    dpk_n, epk_n, epk_a, n_n = (
        from_b64(i["dpk_n_spki_b64"]),
        from_b64(i["epk_n_b64"]),
        from_b64(i["epk_a_b64"]),
        from_b64(i["n_n_b64"]),
    )
    check(
        i["dpk_n_spki_b64"] == keys["dsk_N"]["spki_b64"]
        and i["epk_n_b64"] == keys["esk_N"]["point_b64"]
        and i["epk_a_b64"] == keys["esk_A"]["point_b64"],
        "enrollment inputs are the fixed keys",
    )
    check((i["rid"], i["dev_n"], i["dev_a"]) == (fi["rid"], fi["dev_n"], fi["dev_a"]), "enrollment ids")
    cin = f"sixkey-enroll-commit|2|{i['dev_n']}|{b64u(dpk_n)}|{b64u(epk_n)}|{b64u(n_n)}"
    check(cin == g["commit_input"] and b64(sha256(cin.encode())) == g["commit_b64"], "commitment")
    tr = {
        "rid": i["rid"],
        "devN": i["dev_n"],
        "devA": i["dev_a"],
        "dpkN": dpk_n,
        "epkN": epk_n,
        "epkA": epk_a,
        "nN": n_n,
    }
    T = transcript_of(tr)
    check(T == g["transcript"], "transcript T")
    h = sha256(T.encode())
    check((h.hex(), b64(h), b64u(h)) == (g["h_hex"], g["h_b64"], g["h_b64u"]), "h encodings")
    z_n = ecdh_x(int(keys["esk_N"]["d_hex"], 16), epk_point(epk_a))
    z_a = ecdh_x(int(keys["esk_A"]["d_hex"], 16), epk_point(epk_n))
    check(z_n == z_a and z_n.hex() == g["z_hex"], "ECDH Z (pure Python, both sides)")
    # The pairing secret S: its code as shown, and the IKM Z || S (revision 27).
    s = bytes.fromhex(i["pairing_secret_hex"])
    check(pairing_format(s) == i["pairing_code"] and pairing_parse(i["pairing_code"]) == s, "pairing code of S")
    check(i["ikm_hex"] == (z_n + s).hex(), "IKM = Z || S")
    K = enroll_key(z_n, s, h)
    check(K.hex() == g["k_enroll_hex"], "K_enroll")
    check(K != hkdf(z_n, h, ENROLL_KEY_INFO, 32), "K depends on S")
    sas = six_digits(SAS_TAG, h)
    check(sas == (g["sas_u32"], g["sas"]), "SAS")
    check("cc" not in g and "cc_u32" not in g, "no confirmation code since revision 27")
    ls = g["label_swap"]
    ls_s = bytes.fromhex(ls["secret_hex"])
    check(ls_s == s and ls["as_pairing_code"] == i["pairing_code"], "label swap: the enrollment S")
    check(ls["as_recovery_code"] == recovery_format(s), "label swap: recovery code of S")
    check(
        (ls["pairing_check_bits"], ls["recovery_check_bits"]) == (code_check_bits(s, PAIRING_TAG), code_check_bits(s))
        and ls["pairing_check_bits"] != ls["recovery_check_bits"],
        "label swap: check bits differ",
    )
    for text, parse, want in (
        (ls["as_recovery_code"], pairing_parse, ls["recovery_code_as_pairing_code"]),
        (ls["as_pairing_code"], recovery_parse, ls["pairing_code_as_recovery_code"]),
    ):
        try:
            parse(text)
        except ValueError as e:
            check(str(e) == want, f"label swap: {text}: {e} != {want}")
            continue
        raise Fail(f"label swap: {text} must be rejected")
    check(b64(sha256(dpk_n)) == g["sig_pubkey_sha256_b64"], "sig_pubkey_sha256")
    fields_bytes = {"dpkN", "epkN", "epkA", "nN"}
    for sub_ in g["substitutions"]:
        val = from_b64u(sub_["value_b64u"]) if sub_["field"] in fields_bytes else sub_["value_b64u"]
        t2 = dict(tr, **{sub_["field"]: val})
        check(transcript_of(t2) == sub_["transcript"], f"substituted transcript {sub_['field']}")
        h2 = sha256(sub_["transcript"].encode())
        check(h2.hex() == sub_["h_hex"] and h2 != h, f"substituted h {sub_['field']}")
        check(six_digits(SAS_TAG, h2)[1] == sub_["sas"] != g["sas"], f"substituted SAS {sub_['field']}")
        check("cc" not in sub_, f"substitution {sub_['field']}: no CC")
    sub = {x["field"]: x["value_b64u"] for x in g["substitutions"]}
    m = g["mitm"]
    epk_s1, epk_s2, n_s = from_b64u(sub["epkA"]), from_b64u(sub["epkN"]), from_b64u(sub["nN"])
    check(b64u(epk_s1) == keys["esk_S1"]["point_b64u"] and b64u(epk_s2) == keys["esk_S2"]["point_b64u"], "server keys")
    h1 = sha256(transcript_of(dict(tr, epkA=epk_s1)).encode())
    h2 = sha256(transcript_of(dict(tr, epkN=epk_s2, nN=n_s)).encode())
    check((h1.hex(), h2.hex()) == (m["h1_hex"], m["h2_hex"]), "MITM transcripts")
    check(b64(commit_of(i["dev_n"], dpk_n, epk_s2, n_s)) == m["commit_substituted_b64"], "substituted commitment")
    check(
        six_digits(SAS_TAG, h1)[1] == m["sas_shown_by_N"] and six_digits(SAS_TAG, h2)[1] == m["sas_expected_by_A"],
        "MITM SAS",
    )
    check(m["sas_shown_by_N"] != m["sas_expected_by_A"], "MITM values differ")
    check(
        set(m) == {"note", "commit_substituted_b64", "h1_hex", "h2_hex", "sas_shown_by_N", "sas_expected_by_A"},
        "mitm fields",
    )
    for c in g["commit_checks"]:
        got = (
            b64(commit_of(c["dev_n"], from_b64(c["dpk_n_b64"]), from_b64(c["epk_n_b64"]), from_b64(c["nonce_b64"])))
            == g["commit_b64"]
        )
        check(got == c["opens_pinned_commit"], f"commit check: {c['name']}")
    rn, pl = g["reveal_name"], g["payload"]
    check(
        rn["aad"] == f"sixkey-enroll-name|2|{b64u(h)}" and pl["aad"] == f"sixkey-enroll-payload|2|{b64u(h)}",
        "enrollment AADs",
    )
    check(
        rn["plaintext_padded_b64"] == device_name_rule("Chrome 配置文件")["padded_b64"],
        "reveal name is the padded name",
    )
    P_obj = json.loads(pl["plaintext"])
    check(canonical_json(P_obj) == pl["plaintext"], "payload P is canonical JSON")
    check(
        P_obj["format"] == "sixkey-enroll-payload"
        and P_obj["v"] == 2
        and P_obj["vaultId"] == fi["vault_id"]
        and P_obj["approver"] == fi["dev_a"],
        "payload fields",
    )
    check(
        P_obj["vk"] == b64(bytes.fromhex(fi["vk1_hex"])) and P_obj["bundle"] == V["groups"]["keybundle"]["raw"],
        "payload carries VK1 and the raw bundle",
    )
    wire_n, wire_p = from_b64(rn["wire_b64"]), from_b64(pl["wire_b64"])
    check(
        wire_n[:12] == from_b64(rn["iv_b64"]) and wire_p[:12] == from_b64(pl["iv_b64"]) and len(wire_n) == 188,
        "iv || ct || tag carriage",
    )
    # What each must-not-open key is, recomputed here (the cases that are not simply K): a recording adversary that
    # learns Z (a quantum computer solving ECDH) derives the first three without S; a typo past the check bits is
    # the flipped S.
    s_flipped = s[:15] + bytes([s[15] ^ 0x01])
    h_sub = bytes.fromhex(next(x["h_hex"] for x in g["substitutions"] if x["field"] == "epkA"))
    derived = {
        "K from Z only (the v1 derivation, no S): payload": hkdf(z_n, h, "sixkey/v1/enroll-key", 32),
        "K from Z only (the v1 derivation, no S): reveal name": hkdf(z_n, h, "sixkey/v1/enroll-key", 32),
        "K from Z only with the v2 label": hkdf(z_n, h, ENROLL_KEY_INFO, 32),
        "S with one bit flipped: reveal name": enroll_key(z_n, s_flipped, h),
        "S with one bit flipped: payload": enroll_key(z_n, s_flipped, h),
        "IKM in the wrong order (S || Z)": hkdf(s + z_n, h, ENROLL_KEY_INFO, 32),
        "K derived without salt h": hkdf(z_n + s, b"", ENROLL_KEY_INFO, 32),
        "K and AAD from a substituted transcript (epk_A)": enroll_key(z_n, s, h_sub),
    }
    names = [mn["name"] for mn in g["must_not_open"]]
    check(set(derived) <= set(names), f"must_not_open lacks {sorted(set(derived) - set(names))}")
    for mn in g["must_not_open"]:
        want = derived.get(mn["name"], K)
        check(mn["key_hex"] == want.hex(), f"must not open: key of {mn['name']}")
        check(mn["key_hex"] != K.hex() or mn["name"] not in derived, f"must not open: {mn['name']} is not K")
        w = from_b64(mn["wire_b64"])
        check(len(w) >= 28, f"must not open: {mn['name']} carriage")
    v1_aads = [mn for mn in g["must_not_open"] if re.match(r"sixkey-enroll-(payload|name)\|1\|", mn["aad"])]
    check(len(v1_aads) == 2 and all(mn["key_hex"] == K.hex() for mn in v1_aads), "the v1 AADs under the right K")

    def crypto() -> None:
        priv_n = ec.derive_private_key(int(keys["esk_N"]["d_hex"], 16), ec.SECP256R1())
        pub_a = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk_a)
        check(priv_n.exchange(ec.ECDH(), pub_a) == z_n, "pyca ECDH")
        check(
            gcm_encrypt(K, wire_n[:12], from_b64(rn["plaintext_padded_b64"]), rn["aad"].encode()) == wire_n[12:],
            "reveal name_ct",
        )
        check(gcm_encrypt(K, wire_p[:12], pl["plaintext"].encode(), pl["aad"].encode()) == wire_p[12:], "payload")
        for mn in g["must_not_open"]:
            w = from_b64(mn["wire_b64"])
            check(
                not gcm_opens(bytes.fromhex(mn["key_hex"]), w[:12], w[12:], mn["aad"].encode()),
                f"must not open: {mn['name']}",
            )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_sas(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        h = bytes.fromhex(c["h_hex"])
        check(six_digits(SAS_TAG, h) == (c["sas_u32"], c["sas"]), f"SAS {c['name']}")
        check("cc" not in c, f"{c['name']}: no CC since revision 27")
        m = re.search(r"SHA-256\('([^']+)'\)", c["name"])
        if m:
            check(sha256(m.group(1).encode()) == h, f"search seed {c['name']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_pairing_code(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        secret = bytes.fromhex(c["secret_hex"])
        check(pairing_format(secret) == c["code"], f"pairing code text: {c['name']}")
        check(pairing_parse(c["code"]) == secret, f"pairing code parse: {c['name']}")
        check(code_check_bits(secret, PAIRING_TAG) == c["check_bits"], f"check bits: {c['name']}")
    s = bytes.fromhex(V["groups"]["enrollment"]["inputs"]["pairing_secret_hex"])
    check(g["code"] == pairing_format(s), "the group's code is the enrollment S")
    for x in g["equivalent_inputs"]:
        check(pairing_parse(x) == s, f"equivalent input {x!r}")
    for r in g["rejected_inputs"]:
        try:
            pairing_parse(r["input"])
        except ValueError as e:
            check(str(e) == r["error"], f"{r['input']!r}: {e} != {r['error']}")
            continue
        raise Fail(f"pairing code must be rejected: {r['input']!r}")
    rec = V["groups"]["recovery_auth"]["code"]
    check(any(r["input"] == rec for r in g["rejected_inputs"]), "the recovery code is among the rejected inputs")
    check(recovery_parse(rec) == bytes.fromhex(V["groups"]["recovery_auth"]["secret_hex"]), "it is a recovery code")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_request_signature(g: dict, V: dict) -> dict:
    check(b64u(sha256(b"")) == g["empty_body_sha256_b64u"], "empty body hash")
    for c in g["cases"]:
        check(b64u(sha256(c["body"].encode())) == c["body_sha256_b64u"], f"body hash {c['name']}")
        check(signing_input(c) == c["signing_input"], f"signing input {c['name']}")
        sig = from_b64u(c["sig_p1363_b64u"])
        check(p1363_to_der(sig).hex() == c["sig_der_hex"], f"DER {c['name']}")
        check(
            ecdsa_verify(dpk_point(from_b64(c["signer_key_spki_b64"])), c["signing_input"].encode(), sig),
            f"signature {c['name']}",
        )
    for v in g["verify"]:
        ok = ecdsa_verify(
            dpk_point(from_b64(v["key_spki_b64"])), v["signing_input"].encode(), from_b64u(v["sig_p1363_b64u"])
        )
        check(ok == v["valid"], f"verify: {v['name']}")
    for f in g["signature_format_reject"]:
        check(not p1363_ok(from_b64u(f["sig_b64u"])), f"format reject: {f['name']}")
    for c in g["p1363_to_der"]:
        check(p1363_to_der(bytes.fromhex(c["p1363_hex"])).hex() == c["der_hex"], f"P1363 to DER: {c['name']}")
    for r in g["signing_input_reject"]:
        try:
            signing_input(dict(r, body_sha256_b64u=g["empty_body_sha256_b64u"]))
        except ValueError:
            continue
        raise Fail(f"signing input must be rejected: {r['name']}")

    def crypto() -> None:
        for c in g["cases"]:
            pub = serialization.load_der_public_key(from_b64(c["signer_key_spki_b64"]))
            pub.verify(bytes.fromhex(c["sig_der_hex"]), c["signing_input"].encode(), ec.ECDSA(hashes.SHA256()))
        for v in g["verify"]:
            pub = serialization.load_der_public_key(from_b64(v["key_spki_b64"]))
            try:
                pub.verify(
                    p1363_to_der(from_b64u(v["sig_p1363_b64u"])), v["signing_input"].encode(), ec.ECDSA(hashes.SHA256())
                )
                ok = True
            except InvalidSignature:
                ok = False
            check(ok == v["valid"], f"pyca verify: {v['name']}")

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_number_tokens(g: dict, V: dict) -> dict:
    for c in g["cases"]:
        check(integer_tokens_only(c["text"]) == c["integer_only"], f"number tokens: {c['name']}")
        if "same_value_after_json_parse" in c:
            # Python's default parse keeps 3.0 a float, so compare with the integer-valued reading JS uses.
            loose = json.loads(c["text"], parse_float=lambda s: int(float(s)) if float(s).is_integer() else float(s))
            base = json.loads(g["cases"][0]["text"])
            check(json_equal(loose, base) == c["same_value_after_json_parse"], f"value equality: {c['name']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def v_fork_signature(g: dict, V: dict) -> dict:
    keys = keys_by_name(V)
    check(
        g["old_key_spki_b64"] == keys["dsk_A"]["spki_b64"] and g["new_key_spki_b64"] == keys["dsk_F"]["spki_b64"],
        "fork keys",
    )
    body = json.loads(g["body"])
    check(
        "new_sig" not in body
        and body["new_sig_pubkey"] == g["new_key_spki_b64"]
        and body["new_device_id"] == g["new_device_id"],
        "fork body",
    )
    check(g["signer"] == g["signer_device"] == V["fixed_inputs"]["dev_a"], "the current device signs")
    check(b64u(sha256(g["body"].encode())) == g["body_sha256_b64u"], "fork body hash")
    check(signing_input(g) == g["signing_input"], "fork signing input")
    nc = body["name_ct"]
    check(
        g["name"]["aad"] == f"sixkey-devname|1|{V['fixed_inputs']['vault_id']}|{nc['vkId']}|{g['new_device_id']}",
        "fork name AAD",
    )
    old_pt, new_pt = dpk_point(from_b64(g["old_key_spki_b64"])), dpk_point(from_b64(g["new_key_spki_b64"]))
    msg = g["signing_input"].encode()
    check(ecdsa_verify(old_pt, msg, from_b64u(g["sixkey_sig_b64u"])), "Sixkey-Sig verifies with the current DSK")
    check(ecdsa_verify(new_pt, msg, from_b64u(g["sixkey_new_sig_b64u"])), "Sixkey-New-Sig verifies with new_sig_pubkey")
    for v in g["verify"]:
        ok = ecdsa_verify(
            dpk_point(from_b64(v["key_spki_b64"])), v["signing_input"].encode(), from_b64u(v["sig_p1363_b64u"])
        )
        check(ok == v["valid"], f"fork verify: {v['name']}")

    def crypto() -> None:
        for v in g["verify"]:
            pub = serialization.load_der_public_key(from_b64(v["key_spki_b64"]))
            try:
                pub.verify(
                    p1363_to_der(from_b64u(v["sig_p1363_b64u"])), v["signing_input"].encode(), ec.ECDSA(hashes.SHA256())
                )
                ok = True
            except InvalidSignature:
                ok = False
            check(ok == v["valid"], f"pyca fork verify: {v['name']}")
        k_name = hkdf(bytes.fromhex(V["fixed_inputs"]["vk1_hex"]), b"", "sixkey/v1/device-name", 32)
        pt = AESGCM(k_name).decrypt(from_b64(nc["iv"]), from_b64(nc["ct"]), g["name"]["aad"].encode())
        check(pt.decode().rstrip(" ") == g["name"]["name"], "fork name_ct opens")

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_rotate_repair(g: dict, V: dict) -> dict:
    fi, gr = V["fixed_inputs"], V["groups"]
    vk0, vk1, vk2 = (bytes.fromhex(fi[k]) for k in ("vk0_hex", "vk1_hex", "vk2_hex"))
    vid = lambda vk: hkdf(vk, b"", "sixkey/v1/vk-id", 8).hex()  # noqa: E731
    req, srv = g["request"], g["server"]
    env2, b2 = json.loads(req["envelope"]), json.loads(req["bundle"])
    kr2 = b2["keyring"]
    check(
        srv
        == {
            "version": gr["envelope"]["rev"],
            "kver": gr["keybundle"]["bundle"]["kver"],
            "vk_id": vid(vk1),
            "head_b64": gr["envelope"]["head_b64"],
        },
        "server state is the rolled-back state of the envelope and keybundle groups",
    )
    check(
        env2["vkId"] == kr2["vkId"] == vid(vk2) != srv["vk_id"],
        "repair publishes this device's VK2, unlike the server's vk_id",
    )
    check(req["if_version"] == srv["version"] and env2["rev"] == req["if_version"] + 1, "if_version and rev")
    check(
        req["if_kver"] == srv["kver"]
        and b2["kver"] == publish_kver(srv["kver"], g["device"]["max_seen_kver"]) > req["if_kver"],
        "if_kver and kver = max(server kver, maxSeenKver) + 1",
    )
    aad = f"sixkey-vault|1|{env2['vaultId']}|{env2['vkId']}|{env2['rev']}"
    check(
        b64(sha256(aad.encode(), from_b64(env2["iv"]), from_b64(env2["ciphertext"]))) == env2["checksum"],
        "envelope checksum",
    )
    check(g["write_input"] == f"sixkey-write|1|{fi['vault_id']}|{req['if_version']}|{env2['checksum']}", "write input")
    check(
        b64(hmac256(hkdf(vk1, b"", "sixkey/v1/vault-write", 32), g["write_input"].encode())) == req["write_proof"],
        "write proof with K_write of VK1",
    )
    check(b64(hkdf(vk2, b"", "sixkey/v1/vault-write", 32)) == req["new_write_key"], "new_write_key is K_write of VK2")
    check(bundle_mac(b2, hkdf(vk2, b"", "sixkey/v1/keybundle-mac", 32)) == b2["mac"], "bundle MAC with VK2")
    check(bundle_shape_ok(b2), "bundle shape")
    check({x["vkId"] for x in kr2["previous"]} == {vid(vk0), vid(vk1)}, "previous holds VK1 and VK0 (continuity)")
    server_kdf = gr["keybundle"]["bundle"]["auth"]["kdf"]
    pw = unicodedata.normalize("NFKC", g["password"]).encode()
    pw_auth = hkdf(
        pbkdf2(pw, from_b64(server_kdf["salt"]), server_kdf["iterations"]), b"", "sixkey/v1/password-auth", 32
    )
    check(b64(pw_auth) == req["password_auth"], "password_auth follows the rolled-back bundle's auth.kdf")
    new_kdf = b2["auth"]["kdf"]
    pw_auth2 = hkdf(pbkdf2(pw, from_b64(new_kdf["salt"]), new_kdf["iterations"]), b"", "sixkey/v1/password-auth", 32)
    check(
        b64(sha256(b"sixkey-password-verifier|1|", pw_auth2)) == req["password_verifier"],
        "password_verifier with the new auth salt",
    )
    secret2 = recovery_parse(g["recovery_code2"])
    check(secret2.hex() == g["recovery_secret2_hex"], "recovery code 2")
    rec_auth2 = hkdf(secret2, b"", "sixkey/v1/recovery-auth", 32)
    check(
        b64(sha256(b"sixkey-recovery-verifier|1|", rec_auth2)) == req["recovery_verifier"],
        "recovery_verifier from the typed code",
    )
    for d in req["device_names"]:
        check(
            d["name_ct"]["vkId"] == vid(vk2) and len(from_b64(d["name_ct"]["ct"])) == 176,
            "device names re-encrypted under VK2",
        )

    def crypto() -> None:
        check(
            AESGCM(k_enc(vk2)).decrypt(from_b64(env2["iv"]), from_b64(env2["ciphertext"]), aad.encode()).decode()
            == g["plaintext"],
            "envelope opens with VK2",
        )
        pw_w = next(w for w in kr2["wraps"] if w["method"] == "password")
        rc_w = next(w for w in kr2["wraps"] if w["method"] == "recovery")
        kek_pw = pbkdf2(pw, from_b64(pw_w["kdf"]["salt"]), pw_w["kdf"]["iterations"])
        check(
            AESGCM(kek_pw).decrypt(from_b64(pw_w["iv"]), from_b64(pw_w["wrapped"]), g["aad"]["password"].encode())
            == vk2,
            "password wrap opens to VK2",
        )
        kek_rc = hkdf(secret2, from_b64(rc_w["kdf"]["salt"]), "sixkey/v1/kek-recovery", 32)
        check(
            AESGCM(kek_rc).decrypt(from_b64(rc_w["iv"]), from_b64(rc_w["wrapped"]), g["aad"]["recovery"].encode())
            == vk2,
            "recovery wrap opens to VK2 with code 2",
        )
        kek_pv = hkdf(vk2, b"", "sixkey/v1/kek-previous", 32)
        for x in kr2["previous"]:
            old = AESGCM(kek_pv).decrypt(
                from_b64(x["iv"]),
                from_b64(x["wrapped"]),
                f"sixkey-prev|1|{fi['vault_id']}|{vid(vk2)}|{x['vkId']}".encode(),
            )
            check(vid(old) == x["vkId"], "previous VK opens")
        k_name2 = hkdf(vk2, b"", "sixkey/v1/device-name", 32)
        for d in req["device_names"]:
            nc = d["name_ct"]
            AESGCM(k_name2).decrypt(
                from_b64(nc["iv"]),
                from_b64(nc["ct"]),
                f"sixkey-devname|1|{fi['vault_id']}|{nc['vkId']}|{d['device_id']}".encode(),
            )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


KVER_MAX_JUMP = 65536  # §2.3, §3.9 R0/R1 (§0.0f F-01)
MAX_SAFE = 2**53 - 1


def publish_kver(server_kver: int, max_seen_kver: int) -> int:
    """§3.9 R1 (§0.0e N27, §0.0f F-01): min(max(s, m) + 1, s + KVER_MAX_JUMP); not a safe integer -> kver_overflow."""
    nxt = min(max(server_kver, max_seen_kver) + 1, server_kver + KVER_MAX_JUMP)
    if nxt > MAX_SAFE:
        raise ValueError("kver_overflow")
    return nxt


def server_accept(c: dict) -> str:
    """§2.3 (if_kver < kver <= if_kver + KVER_MAX_JUMP, else 422), then the CAS on if_kver; a failed CAS with identical stored text is 200 (§3.6.0, §5.3)."""
    if not c["if_kver"] < c["kver"] <= c["if_kver"] + KVER_MAX_JUMP:
        return "422 invalid_request"
    if c["if_kver"] != c["server_kver"]:
        return "200 idempotent" if c["raw_equals_stored"] else "409 keys_conflict"
    return "200 applied"


def r1_adoption(max_seen: int, kver: int, same: bool) -> dict:
    """§3.9 R0/R1 (§0.0e N27, §0.0f F-01): past max_seen + KVER_MAX_JUMP counts as <= max_seen, unless max_seen is 0."""
    if kver > max_seen and (max_seen == 0 or kver <= max_seen + KVER_MAX_JUMP):
        return (
            {"outcome": "in_sync", "max_seen_after": kver}
            if same
            else {"outcome": "adopt_candidate", "max_seen_after_adoption": kver}
        )
    if same:
        return {"outcome": "in_sync", "max_seen_after": max_seen}
    return {"outcome": "keys_behind", "max_seen_after": max_seen, "r3_unlock_needs_confirmation": True}


def v_kver_rules(g: dict, V: dict) -> dict:
    check(g["kver_max_jump"] == KVER_MAX_JUMP, "kver_max_jump")
    for c in g["publish"]:
        if "error" in c:
            try:
                publish_kver(c["server_kver"], c["max_seen_kver"])
                check(False, f"publish should overflow: {c}")
            except ValueError as e:
                check(str(e) == c["error"], f"publish error {c}")
        else:
            check(publish_kver(c["server_kver"], c["max_seen_kver"]) == c["publish_kver"], f"publish kver {c}")
    check(any("error" in c for c in g["publish"]), "an overflow case")
    check(
        any(c["kver"] == c["if_kver"] + KVER_MAX_JUMP and c["expect"] == "200 applied" for c in g["server_accept"]),
        "jump bound accepted",
    )
    check(
        any(
            c["kver"] == c["if_kver"] + KVER_MAX_JUMP + 1 and c["expect"] == "422 invalid_request"
            for c in g["server_accept"]
        ),
        "jump bound refused",
    )
    for c in g["server_accept"]:
        check(server_accept(c) == c["expect"], f"server accept: {c['name']}")
    kb = V["groups"]["keybundle"]["bundle"]
    rb = json.loads(V["groups"]["keys_repair"]["request"]["bundle"])
    keyrings = {
        "keybundle": kb["keyring"],
        "keys_repair": rb["keyring"],
        "keybundle_reordered": json.loads(g["keybundle_reordered_text"]),
    }
    kvers = {"keybundle": kb["kver"], "keys_repair": rb["kver"]}
    check(
        g["keybundle_reordered_text"] != json.dumps(kb["keyring"], separators=(",", ":"), ensure_ascii=False),
        "the reordered text really differs",
    )
    for c in g["adoption"]:
        same = canonical_json(keyrings[c["bundle"]]) == canonical_json(keyrings[c["local_keyring"]])
        check(
            same == c["same_keyring"] and (c.get("facts_only") is True or kvers[c["bundle"]] == c["bundle_kver"]),
            f"adoption inputs: {c['name']}",
        )
        want = {
            k: v
            for k, v in c.items()
            if k
            not in ("name", "facts_only", "max_seen_kver", "bundle", "bundle_kver", "local_keyring", "same_keyring")
        }
        check(r1_adoption(c["max_seen_kver"], c["bundle_kver"], same) == want, f"adoption: {c['name']}")
    return {"python-stdlib": "ok", "python-cryptography": "n/a"}


def p4_required(server: dict, nxt: dict) -> "dict | str":
    """P4 (§2.3, §0.0f S-2): which verifiers a key request needs; a wrap changed when its iv or wrapped bytes did."""

    def w(b: dict, m: str) -> dict:
        return next(x for x in b["keyring"]["wraps"] if x["method"] == m)

    def changed(m: str) -> bool:
        return from_b64(w(server, m)["iv"]) != from_b64(w(nxt, m)["iv"]) or from_b64(
            w(server, m)["wrapped"]
        ) != from_b64(w(nxt, m)["wrapped"])

    auth_changed = canonical_json(server["auth"]["kdf"]) != canonical_json(nxt["auth"]["kdf"])
    if changed("password") != auth_changed:
        return "422 invalid_request"
    return {"recovery_verifier": changed("recovery"), "password_verifier": changed("password")}


def v_keys_repair(g: dict, V: dict) -> dict:
    fi, gr = V["fixed_inputs"], V["groups"]
    vk1 = bytes.fromhex(fi["vk1_hex"])
    req, srv = g["request"], g["server"]
    b = json.loads(req["bundle"])
    kr = b["keyring"]
    server_bundle = gr["keybundle"]["bundle"]
    check(
        srv == {"kver": server_bundle["kver"], "vk_id": server_bundle["keyring"]["vkId"]},
        "server state is the keybundle group",
    )
    check(kr["vkId"] == srv["vk_id"], "same VK: no rotation, no write proof")
    check(
        req["if_kver"] == srv["kver"]
        and b["kver"] == publish_kver(srv["kver"], g["device"]["max_seen_kver"]) > req["if_kver"],
        "if_kver = server kver; jumped kver = max(server, maxSeen) + 1",
    )
    check(
        server_accept(
            {"server_kver": srv["kver"], "if_kver": req["if_kver"], "kver": b["kver"], "raw_equals_stored": False}
        )
        == "200 applied",
        "the server accepts it",
    )
    check(
        bundle_mac(b, hkdf(vk1, b"", "sixkey/v1/keybundle-mac", 32)) == b["mac"] and bundle_shape_ok(b),
        "bundle MAC and shape",
    )
    wrap = lambda k, m: next(w for w in k["wraps"] if w["method"] == m)  # noqa: E731
    sk = server_bundle["keyring"]
    check(
        p4_required(server_bundle, b) == {"recovery_verifier": True, "password_verifier": True}
        and "recovery_verifier" in req
        and "password_verifier" in req,
        "P4: both wraps and auth.kdf changed, both verifiers",
    )
    for c in g["p4_cases"]:
        nb = json.loads(c["bundle"])
        check(
            bundle_mac(nb, hkdf(vk1, b"", "sixkey/v1/keybundle-mac", 32)) == nb["mac"] and bundle_shape_ok(nb),
            f"P4 case bundle: {c['name']}",
        )
        check(p4_required(server_bundle, nb) == c["expect"], f"P4 case: {c['name']}")
    check(
        any(
            c["expect"] == {"recovery_verifier": False, "password_verifier": False} and "createdAt" in c["name"]
            for c in g["p4_cases"]
        ),
        "the createdAt-only case (S-2)",
    )
    check(
        {x["vkId"] for x in sk["previous"]} <= {x["vkId"] for x in kr["previous"]},
        "previous contains the server's previous (R2)",
    )
    pw = unicodedata.normalize("NFKC", g["password"]).encode()
    skdf = server_bundle["auth"]["kdf"]
    check(
        b64(hkdf(pbkdf2(pw, from_b64(skdf["salt"]), skdf["iterations"]), b"", "sixkey/v1/password-auth", 32))
        == req["password_auth"],
        "password_auth under the server's auth.kdf",
    )
    nkdf = b["auth"]["kdf"]
    pw_auth3 = hkdf(pbkdf2(pw, from_b64(nkdf["salt"]), nkdf["iterations"]), b"", "sixkey/v1/password-auth", 32)
    check(
        b64(sha256(b"sixkey-password-verifier|1|", pw_auth3)) == req["password_verifier"],
        "password_verifier with the new auth salt",
    )
    secret3 = recovery_parse(g["recovery_code3"])
    check(secret3.hex() == g["recovery_secret3_hex"], "recovery code 3")
    check(
        b64(sha256(b"sixkey-recovery-verifier|1|", hkdf(secret3, b"", "sixkey/v1/recovery-auth", 32)))
        == req["recovery_verifier"],
        "recovery_verifier",
    )

    def crypto() -> None:
        pw_w, rc_w = wrap(kr, "password"), wrap(kr, "recovery")
        kek_pw = pbkdf2(pw, from_b64(pw_w["kdf"]["salt"]), pw_w["kdf"]["iterations"])
        check(
            AESGCM(kek_pw).decrypt(from_b64(pw_w["iv"]), from_b64(pw_w["wrapped"]), g["aad"]["password"].encode())
            == vk1,
            "password wrap opens to VK1",
        )
        kek_rc = hkdf(secret3, from_b64(rc_w["kdf"]["salt"]), "sixkey/v1/kek-recovery", 32)
        check(
            AESGCM(kek_rc).decrypt(from_b64(rc_w["iv"]), from_b64(rc_w["wrapped"]), g["aad"]["recovery"].encode())
            == vk1,
            "recovery wrap opens to VK1 with code 3",
        )

    return {"python-stdlib": "ok", "python-cryptography": _crypto(crypto)}


def v_wire_examples(g: dict, V: dict) -> dict:
    return {"python-stdlib": "checked against the OpenAPI schemas (cross_file_errors)", "python-cryptography": "n/a"}


VERIFIERS: dict[str, Callable[[dict, dict], dict]] = {
    "labels": v_labels,
    "base64url": v_base64url,
    "base64": v_base64,
    "canonical_json": v_canonical_json,
    "time_truncation": v_time,
    "padding": v_padding,
    "vk_subkeys": v_vk_subkeys,
    "envelope": v_envelope,
    "write_proof": v_write_proof,
    "recovery_auth": v_recovery_auth,
    "password_auth": v_password_auth,
    "keybundle": v_keybundle,
    "device_name": v_device_name,
    "device_backup": v_device_backup,
    "public_keys": v_public_keys,
    "enrollment": v_enrollment,
    "sas": v_sas,
    "pairing_code": v_pairing_code,
    "request_signature": v_request_signature,
    "wire_examples": v_wire_examples,
    "number_tokens": v_number_tokens,
    "fork_signature": v_fork_signature,
    "rotate_repair": v_rotate_repair,
    "keys_repair": v_keys_repair,
    "kver_rules": v_kver_rules,
}


def cross_file_errors(V: dict, o: dict) -> list[str]:
    """The vectors and the OpenAPI contract must agree: constants, schemas of the wire values, examples."""
    errs: list[str] = []
    c = {k: v["value"] for k, v in o["x-sixkey-constants"].items()}
    gr = V["groups"]
    pairs = [
        (gr["padding"]["bucket_bytes"], c["PAD_BUCKET_BYTES"], "PAD_BUCKET_BYTES"),
        (gr["device_name"]["padded_bytes"], c["DEVICE_NAME_PADDED_BYTES"], "DEVICE_NAME_PADDED_BYTES"),
        (gr["device_name"]["max_code_points"], c["DEVICE_NAME_MAX_CODE_POINTS"], "DEVICE_NAME_MAX_CODE_POINTS"),
        (
            min(p["iterations"] for p in gr["password_auth"]["kdf_params"]["accept"]),
            c["PBKDF2_MIN_ITERATIONS"],
            "PBKDF2_MIN_ITERATIONS",
        ),
        (
            max(p["iterations"] for p in gr["password_auth"]["kdf_params"]["accept"]),
            c["PBKDF2_MAX_ITERATIONS"],
            "PBKDF2_MAX_ITERATIONS",
        ),
        (
            len(from_b64(gr["device_name"]["encrypt"]["cases"][0]["name_ct"]["ct"])),
            c["DEVICE_NAME_CT_BYTES"],
            "DEVICE_NAME_CT_BYTES",
        ),
        (gr["kver_rules"]["kver_max_jump"], c["KVER_MAX_JUMP"], "KVER_MAX_JUMP"),
        (KVER_MAX_JUMP, c["KVER_MAX_JUMP"], "KVER_MAX_JUMP (reference implementation)"),
    ]
    for got, want, name in pairs:
        if got != want:
            errs.append(f"vectors vs {name}: {got} != {want}")
    S = o["components"]["schemas"]

    def expect(schema_name: str, value: Any, valid: bool, what: str) -> None:
        e = validate(S[schema_name], value, o, what)
        if bool(not e) != valid:
            errs.append(f"{what}: expected {'valid' if valid else 'invalid'} for {schema_name}: {e[:3]}")

    for k in gr["public_keys"]["keys"]:
        expect("SpkiP256", k["spki_b64"], True, f"public key {k['name']}")
        expect("EcPointP256", k["point_b64"], True, f"point {k['name']}")
    for r in gr["public_keys"]["epk_reject"][:3]:
        expect("EcPointP256", r["b64"], False, f"epk reject {r['name']}")
    expect("EnvelopeText", gr["envelope"]["envelope_text"], True, "envelope text")
    expect("BundleText", gr["keybundle"]["raw"], True, "bundle raw")
    for m in gr["keybundle"]["mac_cases"]:
        expect("BundleText", m["raw"], True, f"MAC case {m['name']}")
    for s in gr["keybundle"]["shape_cases"]:
        expect("BundleText", s["raw"], s["shape_valid"] if s["schema_expressible"] else True, f"shape case {s['name']}")
    for d in gr["device_name"]["encrypt"]["cases"]:
        expect("NameCt", d["name_ct"], True, f"name_ct {d['device_id']}")
    expect("EnrollNameCiphertext", gr["enrollment"]["reveal_name"]["wire_b64"], True, "reveal name_ct")
    expect("EnrollPayloadCiphertext", gr["enrollment"]["payload"]["wire_b64"], True, "payload")
    expect("RequestId", gr["enrollment"]["inputs"]["rid"], True, "rid")
    for name in ("dev_n", "dev_a", "dev_s"):
        expect("DeviceId", V["fixed_inputs"][name], True, name)
    for ex in gr["wire_examples"]["examples"]:
        e = wire_example_errors(o, ex)
        if ex.get("expect_valid", True) and e:
            errs += e
        elif not ex.get("expect_valid", True) and not e:
            errs.append(f"{ex['operation']} {ex['kind']}: the counterexample was accepted ({ex.get('why', '')})")
    sig_param = o["components"]["parameters"]["SixkeySig"]["schema"]
    for rc in gr["request_signature"]["cases"]:
        if validate(sig_param, rc["sig_p1363_b64u"], o):
            errs.append(f"Sixkey-Sig value does not match the header schema: {rc['name']}")
    return errs
