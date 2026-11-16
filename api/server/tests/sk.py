"""Test-side client for the Sixkey API: device keys, signed requests, valid bodies, and a contract check
of every response.

- Every response the tests receive is validated against api/openapi.yaml with the INDEPENDENT validator
  in contract/py/sixkey_contract.py (not the server's): status listed for the operation, body schema
  (error bodies included), and the error code listed under that status (or applies_to any).
- Every secret-like value a test creates is registered in SECRETS so the log scan can look for it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("SIXKEY_REPO_ROOT") or os.path.normpath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "contract", "py"))
_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # leave no __pycache__ inside contract/
import sixkey_contract as SC  # noqa: E402  (the independent reference implementation and validator)

sys.dont_write_bytecode = _dwb

OPENAPI = SC.load_json(SC.OPENAPI_PATH)
VECTORS = SC.load_json(SC.VECTORS_PATH)
HOST = "api.sixkey.app"
HOUR = 3_600_000

SECRETS: set[str] = set()  # values that must never appear in any server log
SEEN: set[tuple[str, int, str | None]] = set()  # (operationId, status, error code)
SEEN_OPS_2XX: set[str] = set()
ALLOW_5XX = {"value": False}  # fault-injection tests switch it on


def secret(v: str) -> str:
    if v and len(v) >= 6:
        SECRETS.add(v)
    return v


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def rnd(n: int) -> bytes:
    return secrets.token_bytes(n)


def sha256(*parts: bytes) -> bytes:
    return hashlib.sha256(b"".join(parts)).digest()


def compact(obj: Any) -> str:
    """JSON.stringify output (what the extension sends)."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# ------------------------------------------------------------------------------------ operations

_OPS = []
for _p, _item in OPENAPI["paths"].items():
    for _m, _op in _item.items():
        _rx = re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", _p) + "$")
        _OPS.append((_m.upper(), _rx, _p, _op))


def find_op(method: str, path: str) -> tuple[str, dict] | None:
    for m, rx, p, op in sorted(_OPS, key=lambda x: "{" in x[2]):  # literal paths before templates
        if m == method and rx.match(path):
            return p, op
    return None


class ContractViolation(AssertionError):
    pass


class NotStrict(ValueError):
    pass


def strict_json(text: str):
    """The contract's text rules for JSON inside a string (N20, A18), written here independently of the
    server: integer tokens within ±(2^53 - 1) only, no NaN/Infinity, no duplicate keys, no NUL and no
    lone surrogates. Review S14 found contract/py's validate() parsing contentSchema texts with plain
    json.loads; contract/py now parses them strictly too (parse_strict_json, A18), and this helper stays as
    a second, independently written oracle for what the server returns (test_review checks they agree)."""

    def bad(tok):
        raise NotStrict(f"number token {tok}")

    def integer(tok):
        v = int(tok)
        if abs(v) > 2**53 - 1:
            raise NotStrict("unsafe integer")
        return v

    def pairs(kv):
        d = {}
        for k, v in kv:
            if k in d:
                raise NotStrict("duplicate key")
            d[k] = v
        return d

    try:
        v = json.loads(text, parse_float=bad, parse_int=integer, parse_constant=bad, object_pairs_hook=pairs)
    except NotStrict:
        raise
    except ValueError as e:
        raise NotStrict(str(e)) from None
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, str):
            if "\x00" in x:
                raise NotStrict("NUL")
            x.encode("utf-8")  # raises on a lone surrogate
        elif isinstance(x, dict):
            stack.extend(x.keys())
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
    return v


TEXT_SCHEMAS = {"envelope": "EncryptedVault", "bundle": "KeyBundle"}


def check_texts(oid: str, data: dict) -> None:
    for field, sch in TEXT_SCHEMAS.items():
        if isinstance(data.get(field), str):
            try:
                inner = strict_json(data[field])
            except (NotStrict, UnicodeEncodeError) as e:
                raise ContractViolation(f"{oid}: {field} text is not strict JSON ({e})") from None
            errs = SC.validate(OPENAPI["components"]["schemas"][sch], inner, OPENAPI, f"{oid}.{field}")
            if errs:
                raise ContractViolation(f"{oid}: {field} {errs[:3]}")


def check_response(method: str, path: str, status: int, headers: httpx.Headers, body: bytes) -> None:
    found = find_op(method, path)
    if found is None:
        return  # not an operation of the contract (e.g. a deliberately unknown route)
    _, op = found
    oid = op["operationId"]
    responses = op["responses"]
    if status >= 500 and not ALLOW_5XX["value"]:
        raise ContractViolation(f"{method} {path}: unexpected {status}: {body[:200]!r}")
    if status >= 500:  # internal_error / unavailable apply to any operation (x-sixkey-error-codes)
        data = json.loads(body)
        errs = SC.validate(OPENAPI["components"]["schemas"]["ErrorBody"], data, OPENAPI, f"{oid} {status}")
        code = data["error"]["code"]
        if (
            errs
            or OPENAPI["x-sixkey-error-codes"][code].get("applies_to") != "any"
            or OPENAPI["x-sixkey-error-codes"][code]["status"] != status
        ):
            raise ContractViolation(f"{oid}: bad {status} body {errs[:3]}")
        SEEN.add((oid, status, code))
        return
    if str(status) not in responses:
        raise ContractViolation(f"{method} {path}: status {status} is not in the contract ({sorted(responses)})")
    code = None
    if status == 204:
        if body:
            raise ContractViolation(f"{oid}: 204 with a body")
    else:
        resp = SC.deref(OPENAPI, responses[str(status)])
        schema = resp["content"]["application/json"]["schema"]
        try:
            data = json.loads(body)
        except ValueError:
            raise ContractViolation(f"{oid}: {status} body is not JSON") from None
        errs = SC.validate(schema, data, OPENAPI, f"{oid} {status}")
        if errs:
            raise ContractViolation(f"{oid} {status}: {errs[:4]}")
        if status < 400:
            check_texts(oid, data)
        if status >= 400:
            code = data["error"]["code"]
            table = OPENAPI["x-sixkey-error-codes"][code]
            listed = op["x-sixkey-errors"].get(str(status), [])
            if table["status"] != status or (code not in listed and table.get("applies_to") != "any"):
                raise ContractViolation(f"{oid}: {status} {code} is not listed for this operation")
            if status in (429, 503) and "retry-after" not in headers:
                raise ContractViolation(f"{oid}: {status} without Retry-After")
    SEEN.add((oid, status, code))
    if 200 <= status < 300:
        SEEN_OPS_2XX.add(oid)


async def _hook(response: httpx.Response) -> None:
    await response.aread()
    check_response(
        response.request.method, response.request.url.path, response.status_code, response.headers, response.content
    )


def client(app: Any, ip: str = "203.0.113.7") -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, client=(ip, 51234))
    return httpx.AsyncClient(
        transport=transport, base_url=f"https://{HOST}", event_hooks={"response": [_hook]}, timeout=60
    )


# ------------------------------------------------------------------------------------ keys and bodies


class Dev:
    """A device (or an enrolling device): its id and its P-256 signing key."""

    def __init__(self, device_id: str | None = None) -> None:
        self.device_id = device_id or b64u(rnd(16))
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.spki = self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.spki_b64 = b64(self.spki)

    def sign_p1363(self, msg: bytes) -> bytes:
        r, s = decode_dss_signature(self.key.sign(msg, ec.ECDSA(hashes.SHA256())))
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    def sign(self, msg: bytes) -> str:
        return secret(b64u(self.sign_p1363(msg)))


def signing_input(
    method: str, target: str, signer: str, sub: str, ts: int | str, body: bytes, host: str = HOST
) -> bytes:
    return f"sixkey-req|1|{host}|{method}|{target}|{signer}|{sub}|{ts}|{b64u(sha256(body))}".encode()


def ec_point() -> bytes:
    return (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    )


def vk_id() -> str:
    return rnd(8).hex()


def envelope(vault_id: str, vkid: str, rev: int, ct_len: int = 64) -> tuple[str, str]:
    """An EncryptedVault text with a correct keyless checksum (the ciphertext is random bytes)."""
    iv, ct = rnd(12), rnd(ct_len)
    aad = f"sixkey-vault|1|{vault_id}|{vkid}|{rev}".encode()
    checksum = b64(sha256(aad, iv, ct))
    e = {
        "format": "sixkey-vault",
        "formatVersion": 1,
        "cipher": "AES-256-GCM",
        "vaultId": vault_id,
        "vkId": vkid,
        "rev": rev,
        "iv": b64(iv),
        "ciphertext": b64(ct),
        "checksum": checksum,
    }
    return secret(compact(e)), checksum


def envelope_of_size(vault_id: str, vkid: str, rev: int, size: int) -> tuple[str, str]:
    """An envelope whose JSON text is exactly `size` bytes (size >= ~300)."""
    text, _ = envelope(vault_id, vkid, rev, 16)
    over = len(text.encode()) - len(b64(rnd(16)))
    target_b64 = size - over - 16  # leave room for the padding member below
    ct_len = target_b64 // 4 * 3
    text, cs = envelope(vault_id, vkid, rev, ct_len)
    pad = size - len(text.encode())
    assert pad >= 7
    # an unknown member is allowed in the envelope object (EncryptedVault has no additionalProperties: false)
    text = text[:-1] + ',"x":"' + "a" * (pad - 7) + '"}'
    assert len(text.encode()) == size, (len(text.encode()), size)
    return text, cs


def kdf_pbkdf2() -> dict:
    return {"name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": b64(rnd(16)), "v": 1}


def wrap(method: str, vkid: str, at: int) -> dict:
    kdf = kdf_pbkdf2() if method == "password" else {"name": "HKDF", "hash": "SHA-256", "salt": b64(rnd(16)), "v": 1}
    return {"method": method, "vkId": vkid, "kdf": kdf, "iv": b64(rnd(12)), "wrapped": b64(rnd(48)), "createdAt": at}


@dataclass
class Keys:
    """What an honest client knows about a vault's key state (the test oracle for the server)."""

    vault_id: str
    vk_id: str
    at: int
    write_key: bytes = field(default_factory=lambda: rnd(32))
    pw_auth: bytes = field(default_factory=lambda: rnd(32))
    rec_auth: bytes = field(default_factory=lambda: rnd(32))
    pw_wrap: dict = field(default_factory=dict)
    rec_wrap: dict = field(default_factory=dict)
    auth_kdf: dict = field(default_factory=kdf_pbkdf2)
    previous: list = field(default_factory=list)
    kver: int = 1
    version: int = 1
    bundle_text: str = ""

    def __post_init__(self) -> None:
        self.pw_wrap = self.pw_wrap or wrap("password", self.vk_id, self.at)
        self.rec_wrap = self.rec_wrap or wrap("recovery", self.vk_id, self.at)
        for v in (b64(self.write_key), b64(self.pw_auth), b64(self.rec_auth)):
            secret(v)

    @property
    def pw_auth_b64(self) -> str:
        return b64(self.pw_auth)

    @property
    def rec_auth_b64(self) -> str:
        return b64(self.rec_auth)

    def pw_verifier(self, pw_auth: bytes | None = None) -> str:
        return secret(b64(sha256(b"sixkey-password-verifier|1|", pw_auth or self.pw_auth)))

    def rec_verifier(self, rec_auth: bytes | None = None) -> str:
        return secret(b64(sha256(b"sixkey-recovery-verifier|1|", rec_auth or self.rec_auth)))

    def bundle(self, by: str, kver: int | None = None, **over: Any) -> str:
        b = {
            "format": "sixkey-keybundle",
            "v": 1,
            "vaultId": self.vault_id,
            "kver": kver or self.kver,
            "keyring": {
                "format": "sixkey-keyring",
                "v": 1,
                "vaultId": self.vault_id,
                "vkId": self.vk_id,
                "wraps": [self.pw_wrap, self.rec_wrap],
                "previous": self.previous,
            },
            "auth": {"kdf": self.auth_kdf},
            "by": by,
            "at": self.at,
            "mac": b64(rnd(32)),
        }
        b.update(over)
        return secret(compact(b))

    def proof(self, if_version: int, checksum: str, write_key: bytes | None = None) -> str:
        msg = f"sixkey-write|1|{self.vault_id}|{if_version}|{checksum}".encode()
        return secret(b64(hmac.new(write_key or self.write_key, msg, hashlib.sha256).digest()))

    def name_ct(self, vkid: str | None = None) -> dict:
        return {"vkId": vkid or self.vk_id, "iv": b64(rnd(12)), "ct": b64(rnd(176))}


@dataclass
class Acct:
    email: str
    token: str
    sub: str


# ------------------------------------------------------------------------------------ the API


class Api:
    def __init__(self, http: httpx.AsyncClient, clock: Any, host: str = HOST) -> None:
        self.http, self.clock, self.host = http, clock, host

    async def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        dev: Dev | None = None,
        enroll: tuple[str, Dev] | None = None,
        acct: Acct | None = None,
        reg: Dev | None = None,
        ts: int | str | None = None,
        raw: bytes | None = None,
        headers: dict | None = None,
        sub: str | None = None,
        target: str | None = None,
        host: str | None = None,
        sign: bool = True,
        new_sig: Dev | None = None,
        signer: str | None = None,
        send_body: bool = True,
    ) -> httpx.Response:
        data = raw if raw is not None else (compact(body).encode() if body is not None else b"")
        h = dict(headers or {})
        if acct is not None:
            h["Authorization"] = f"Bearer {acct.token}"
        ts = self.clock.now_ms() if ts is None else ts
        key = None
        if dev is not None:
            h["Sixkey-Device"], key, signer = dev.device_id, dev, signer or dev.device_id
        elif enroll is not None:
            h["Sixkey-Enroll"], key, signer = enroll[0], enroll[1], signer or "enroll:" + enroll[0]
        elif reg is not None:
            h["Sixkey-Device"], key, signer = reg.device_id, reg, signer or reg.device_id
        if key is not None and sign:
            msg = signing_input(
                method,
                target or path,
                signer,
                sub if sub is not None else (acct.sub if acct is not None else "-"),
                ts,
                data,
                host or self.host,
            )
            h["Sixkey-Ts"], h["Sixkey-Sig"] = str(ts), key.sign(msg)
            if new_sig is not None:
                h["Sixkey-New-Sig"] = new_sig.sign(msg)
        if data and "Content-Type" not in h:
            h["Content-Type"] = "application/json"
        return await self.http.request(method, path, content=data if send_body else b"", headers=h)

    # -- auth
    async def login(self, provider: Any, email: str | None = None) -> Acct:
        email = secret(email or f"user-{secrets.token_hex(6)}@example.invalid")
        r = await self.call("POST", "/v1/auth/otp", {"email": email})
        assert r.status_code == 202, r.text
        code = secret(provider.last_code(email))
        r = await self.call("POST", "/v1/auth/verify", {"email": email, "token": code})
        assert r.status_code == 200, r.text
        tok = secret(r.json()["account_token"])
        sub = json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "==="))["sub"]
        return Acct(email, tok, sub)

    # -- vault
    async def init(self, acct: Acct, dev: Dev, keys: Keys, **over: Any) -> httpx.Response:
        env, _ = envelope(keys.vault_id, keys.vk_id, 1)
        keys.bundle_text = keys.bundle(dev.device_id)
        body = {
            "vault_id": keys.vault_id,
            "envelope": env,
            "bundle": keys.bundle_text,
            "recovery_verifier": keys.rec_verifier(),
            "password_verifier": keys.pw_verifier(),
            "write_key": b64(keys.write_key),
            "device": {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "name_ct": keys.name_ct()},
        }
        body.update(over)
        return await self.call("POST", "/v1/vault/init", body, acct=acct, reg=dev)

    async def put_vault(
        self,
        dev: Dev,
        keys: Keys,
        if_version: int | None = None,
        *,
        cursor: dict | None = None,
        env: tuple[str, str] | None = None,
        proof: str | None = None,
        **kw: Any,
    ) -> httpx.Response:
        iv = keys.version if if_version is None else if_version
        text, cs = env or envelope(keys.vault_id, keys.vk_id, iv + 1)
        body = {
            "if_version": iv,
            "envelope": text,
            "write_proof": proof or keys.proof(iv, cs),
            "cursor": cursor or {"pending": b64(rnd(16))},
        }
        return await self.call("PUT", "/v1/vault", body, dev=dev, **kw)

    async def status(self, dev: Dev, **kw: Any) -> httpx.Response:
        return await self.call("GET", "/v1/sync/status", dev=dev, **kw)


def new_vault_keys(at: int) -> Keys:
    return Keys(vault_id="v-" + secrets.token_hex(8), vk_id=vk_id(), at=at)


def uuid4() -> str:
    return str(uuid.uuid4())
