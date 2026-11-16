"""Request signatures (§5.2, x-sixkey-signature).

signing input = sixkey-req|1|{host}|{METHOD}|{target}|{signer}|{sub}|{ts}|{base64url(SHA-256(body))}
- host: the configured API host, never the Host header;
- target: the raw request target (path and query exactly as sent); '|' is refused;
- signer: deviceId or enroll:{rid}; sub: JWT sub when the operation carries an account session, else '-';
- signature: base64url of the 64-byte IEEE P1363 r||s, 0 < r, s < n, verified as DER.
"""

from __future__ import annotations

import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from .constants import SIGNING_PREFIX
from .wire import b64ud, b64ue, sha256

P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
TS_RE = re.compile(r"[0-9]{1,16}\Z")
DEVICE_ID_RE = re.compile(r"[A-Za-z0-9_-]{22}\Z")
RID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
SIG_RE = re.compile(r"[A-Za-z0-9_-]{86}\Z")


def raw_target(scope: dict) -> str | None:
    """The raw request target from the ASGI scope, or None when it cannot be used."""
    raw = scope.get("raw_path")
    if not isinstance(raw, (bytes, bytearray)):
        return None
    try:
        path = bytes(raw).decode("ascii")
        query = bytes(scope.get("query_string") or b"").decode("ascii")
    except UnicodeDecodeError:
        return None
    target = path + ("?" + query if query else "")
    if not target.startswith("/") or "|" in target or any(c < " " or c == "\x7f" for c in target):
        return None
    return target


def signing_input(host: str, method: str, target: str, signer: str, sub: str, ts: str, body: bytes) -> bytes:
    return (f"{SIGNING_PREFIX}{host}|{method}|{target}|{signer}|{sub}|{ts}|{b64ue(sha256(body))}").encode()


def parse_sig(value: str | None) -> bytes | None:
    """Header value -> 64 bytes with 0 < r, s < n, or None."""
    if value is None or not SIG_RE.match(value):
        return None
    sig = b64ud(value)
    if sig is None or len(sig) != 64:
        return None
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (0 < r < P256_N and 0 < s < P256_N):
        return None
    return sig


def verify(key: ec.EllipticCurvePublicKey, msg: bytes, sig: bytes) -> bool:
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    try:
        key.verify(encode_dss_signature(r, s), msg, ec.ECDSA(hashes.SHA256()))
        return True
    except InvalidSignature:
        return False


def ts_ok(value: str | None) -> bool:
    return value is not None and TS_RE.match(value) is not None
