"""Strict JSON and the request schemas of api/openapi.yaml.

The server validates every request body against the operation's request schema in the contract
itself (loaded once at startup), with this small JSON Schema subset validator. It is written
independently of contract/py/sixkey_contract.py, which the tests use as the oracle for responses.

Strict JSON (§2.3, §5.4 N20): number tokens must be integer literals within ±(2^53 - 1); no NaN or
Infinity; no duplicate object keys; no lone surrogates or NUL in any string. Anything else is 422.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .constants import MAX_SAFE_INTEGER

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OPENAPI = os.path.normpath(os.path.join(HERE, "..", "..", "openapi.yaml"))


class JsonError(ValueError):
    pass


def _no_float(tok: str) -> Any:
    raise JsonError("non-integer number token")


def _safe_int(tok: str) -> int:
    v = int(tok)
    if abs(v) > MAX_SAFE_INTEGER:
        raise JsonError("integer outside the safe range")
    return v


def _no_constant(tok: str) -> Any:
    raise JsonError("NaN or Infinity")


def _no_dupes(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in pairs:
        if k in out:
            raise JsonError("duplicate key")
        out[k] = v
    return out


def _check_strings(v: Any) -> None:
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, str):
            if "\x00" in x:
                raise JsonError("NUL in a string")
            try:
                x.encode("utf-8")
            except UnicodeEncodeError:
                raise JsonError("lone surrogate") from None
        elif isinstance(x, dict):
            for k, val in x.items():
                stack.append(k)
                stack.append(val)
        elif isinstance(x, list):
            stack.extend(x)


def parse_strict(text: str) -> Any:
    """Parse JSON text with the contract's number rule; raises JsonError."""
    try:
        v = json.loads(
            text, parse_float=_no_float, parse_int=_safe_int, parse_constant=_no_constant, object_pairs_hook=_no_dupes
        )
    except JsonError:
        raise
    except (ValueError, RecursionError):
        raise JsonError("not JSON") from None
    _check_strings(v)
    return v


def parse_body(raw: bytes) -> Any:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise JsonError("body is not UTF-8") from None
    return parse_strict(text)


# ---------------------------------------------------------------------------------------- validator

_ASSERTIONS = {
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
}
_ANNOTATIONS = {
    "contentMediaType",
    "description",
    "format",
    "title",
    "examples",
    "default",
    "$schema",
    "$id",
    "$comment",
    "$defs",
    "deprecated",
    "readOnly",
    "writeOnly",
}
_SUPPORTED = _ASSERTIONS | _ANNOTATIONS
_SUBSCHEMA = {"items", "additionalProperties", "not", "contains", "contentSchema", "if", "then", "else"}


def check_supported(schema: object, where: str = "#") -> None:
    """Refuse, at startup, a contract that uses a keyword this validator would silently not enforce."""
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise ValueError(f"{where}: a schema must be an object or a boolean")
    for k, v in schema.items():
        if k.startswith("x-"):
            continue
        if k not in _SUPPORTED:
            raise ValueError(f"{where}: unsupported schema keyword {k}")
        if k in ("properties", "$defs"):
            for name, sub in v.items():
                check_supported(sub, f"{where}/{k}/{name}")
        elif k in _SUBSCHEMA:
            check_supported(v, f"{where}/{k}")
        elif k in ("oneOf", "anyOf", "allOf"):
            for i, sub in enumerate(v):
                check_supported(sub, f"{where}/{k}/{i}")


_B64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
_B64_FAST = re.compile(r"[A-Za-z0-9+/]*\Z")


def _b64_ok(s: str) -> bool:
    """Same language as _B64_PATTERN without regex backtracking over multi-megabyte ciphertexts."""
    if len(s) % 4:
        return False
    body = s[:-2] if s.endswith("==") else s[:-1] if s.endswith("=") else s
    return _B64_FAST.match(body) is not None


class Validator:
    def __init__(self, root: dict) -> None:
        self.root = root
        self._re: dict[str, re.Pattern[str]] = {}

    def _pattern(self, p: str) -> re.Pattern[str]:
        c = self._re.get(p)
        if c is None:
            # ECMA-262: '$' only matches at the very end (Python's also matches before a final '\n').
            q = p[:-1] + r"\Z" if p.endswith("$") and not p.endswith("\\$") else p
            c = self._re[p] = re.compile(q)
        return c

    def resolve(self, ref: str) -> Any:
        if not ref.startswith("#/"):
            raise ValueError(f"unsupported $ref {ref}")
        node: Any = self.root
        for part in ref[2:].split("/"):
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node

    def valid(self, schema: Any, inst: Any) -> bool:
        if schema is True:
            return True
        if schema is False:
            return False
        s = schema
        if "$ref" in s and not self.valid(self.resolve(s["$ref"]), inst):
            return False
        if "type" in s:
            types = s["type"] if isinstance(s["type"], list) else [s["type"]]
            if not any(_is(inst, t) for t in types):
                return False
        if "enum" in s and not any(_eq(inst, e) for e in s["enum"]):
            return False
        if "const" in s and not _eq(inst, s["const"]):
            return False
        if isinstance(inst, str):
            if "minLength" in s and len(inst) < s["minLength"]:
                return False
            if "maxLength" in s and len(inst) > s["maxLength"]:
                return False
            if "pattern" in s:
                if s["pattern"] == _B64_PATTERN:
                    if not _b64_ok(inst):
                        return False
                elif not self._pattern(s["pattern"]).search(inst):
                    return False
            if "contentSchema" in s and s.get("contentMediaType") == "application/json":
                try:
                    inner = parse_strict(inst)
                except JsonError:
                    return False
                if not self.valid(s["contentSchema"], inner):
                    return False
        if _is(inst, "number"):
            if "minimum" in s and inst < s["minimum"]:
                return False
            if "maximum" in s and inst > s["maximum"]:
                return False
            if "multipleOf" in s and inst % s["multipleOf"] != 0:
                return False
        if isinstance(inst, list):
            if "minItems" in s and len(inst) < s["minItems"]:
                return False
            if "maxItems" in s and len(inst) > s["maxItems"]:
                return False
            if "items" in s and not all(self.valid(s["items"], x) for x in inst):
                return False
            if "contains" in s and not any(self.valid(s["contains"], x) for x in inst):
                return False
            if s.get("uniqueItems") and any(
                _eq(inst[i], inst[j]) for i in range(len(inst)) for j in range(i + 1, len(inst))
            ):
                return False
        if isinstance(inst, dict):
            if any(r not in inst for r in s.get("required", [])):
                return False
            props = s.get("properties", {})
            for k, v in inst.items():
                if k in props:
                    if not self.valid(props[k], v):
                        return False
                elif "additionalProperties" in s and not self.valid(s["additionalProperties"], v):
                    return False
        if "allOf" in s and not all(self.valid(x, inst) for x in s["allOf"]):
            return False
        if "anyOf" in s and not any(self.valid(x, inst) for x in s["anyOf"]):
            return False
        if "oneOf" in s and sum(1 for x in s["oneOf"] if self.valid(x, inst)) != 1:
            return False
        if "not" in s and self.valid(s["not"], inst):
            return False
        if "if" in s:
            branch = s.get("then") if self.valid(s["if"], inst) else s.get("else")
            if branch is not None and not self.valid(branch, inst):
                return False
        return True


def _is(v: Any, t: str) -> bool:
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
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    raise ValueError(f"unknown type {t}")


def _eq(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


class Contract:
    """api/openapi.yaml: request schemas and limits by operationId."""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get("SIXKEY_OPENAPI_PATH") or DEFAULT_OPENAPI
        with open(self.path, encoding="utf-8") as f:
            self.doc = json.load(f)  # JSON syntax, valid YAML 1.2 (§0.0d N0)
        self.validator = Validator(self.doc)
        for name, sch in self.doc["components"]["schemas"].items():
            check_supported(sch, f"#/components/schemas/{name}")
        self.ops: dict[str, dict] = {}
        for path_t, item in self.doc["paths"].items():
            for method, op in item.items():
                rb = op.get("requestBody")
                if rb:
                    check_supported(rb["content"]["application/json"]["schema"], f"{path_t} {method}")
                self.ops[op["operationId"]] = {
                    "method": method.upper(),
                    "path": path_t,
                    "request_schema": rb["content"]["application/json"]["schema"] if rb else None,
                    "max_body": op.get("x-sixkey-max-body-bytes"),
                }

    def schema(self, name: str) -> dict:
        return self.doc["components"]["schemas"][name]

    def request_valid(self, op_id: str, body: Any) -> bool:
        s = self.ops[op_id]["request_schema"]
        return s is not None and self.validator.valid(s, body)

    def valid(self, schema_name: str, value: Any) -> bool:
        return self.validator.valid(self.schema(schema_name), value)
