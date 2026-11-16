"""Keyless checks (§5.1 wire.py): encodings, public keys, envelope, KeyBundle, P4, write proof, verifiers.

Nothing here needs a VK; every function either returns a normalized value or raises ApiError
("invalid_request" unless stated). Error messages never carry user data.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec

from .constants import (
    HOUR_MS,
    KVER_MAX_JUMP,
    MAX_ENVELOPE_BYTES,
    PASSWORD_VERIFIER_PREFIX,
    RECOVERY_VERIFIER_PREFIX,
    WRITE_PROOF_PREFIX,
)
from .errors import ApiError
from .schema import Contract, JsonError, parse_strict

SPKI_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
_B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")
_B64U_RE = re.compile(r"[A-Za-z0-9_-]*\Z")


def bad(code: str = "invalid_request") -> ApiError:
    return ApiError(code)


# ---------------------------------------------------------------------------------------- encodings


def b64d(s: Any) -> bytes:
    """Standard base64 with Phase 0 fromB64 rules (length % 4 == 0, padding only at the end)."""
    if not isinstance(s, str) or len(s) % 4 or not _B64_RE.match(s):
        raise bad()
    try:
        return base64.b64decode(s, validate=True)
    except ValueError:
        raise bad() from None


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64ud(s: Any) -> bytes | None:
    """Strict base64url (§2.2 N19): no padding, no other characters, canonical trailing bits."""
    if not isinstance(s, str) or not _B64U_RE.match(s) or len(s) % 4 == 1:
        return None
    b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    return b if b64ue(b) == s else None


def b64ue(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


# ---------------------------------------------------------------------------------------- keys


def spki_public_key(spki: bytes) -> ec.EllipticCurvePublicKey:
    """§2.2: dpk is exactly the 91-byte P-256 SPKI DER of an uncompressed point on the curve."""
    if len(spki) != 91 or spki[:26] != SPKI_P256_PREFIX:
        raise bad()
    return point_public_key(spki[26:])


def point_public_key(raw: bytes) -> ec.EllipticCurvePublicKey:
    """§2.2: epk is exactly the 65-byte uncompressed point 0x04 || x || y, on P-256."""
    if len(raw) != 65 or raw[0] != 4:
        raise bad()
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        raise bad() from None


# ---------------------------------------------------------------------------------------- verifiers


def verifier(prefix: bytes, auth: bytes) -> bytes:
    return sha256(prefix, auth)


def password_verifier_of(pw_auth: bytes) -> bytes:
    return verifier(PASSWORD_VERIFIER_PREFIX, pw_auth)


def recovery_verifier_of(rec_auth: bytes) -> bytes:
    return verifier(RECOVERY_VERIFIER_PREFIX, rec_auth)


def proof_matches(prefix: bytes, auth_b64: str, stored_verifier: bytes) -> bool:
    try:
        auth = b64d(auth_b64)
    except ApiError:
        return False
    return len(auth) == 32 and hmac.compare_digest(verifier(prefix, auth), bytes(stored_verifier))


def write_proof_ok(write_key: bytes, vault_id: str, if_version: int, checksum_b64: str, proof_b64: str) -> bool:
    """§5.2: write_proof = HMAC-SHA256(K_write, 'sixkey-write|1|{vaultId}|{if_version}|{checksum}')."""
    msg = f"{WRITE_PROOF_PREFIX}{vault_id}|{if_version}|{checksum_b64}".encode()
    expected = hmac.new(bytes(write_key), msg, hashlib.sha256).digest()
    try:
        got = b64d(proof_b64)
    except ApiError:
        return False
    return hmac.compare_digest(expected, got)


# ---------------------------------------------------------------------------------------- envelope


@dataclass(frozen=True)
class Envelope:
    text: str
    vault_id: str
    vk_id: str
    rev: int
    checksum: str
    size_bytes: int
    head: bytes


def envelope(contract: Contract, text: str) -> Envelope:
    """EncryptedVault text: size (413), strict JSON, shape, keyless checksum (§4.1, §4.3, §5.3)."""
    raw = text.encode("utf-8")
    if len(raw) > MAX_ENVELOPE_BYTES:
        raise ApiError("too_large")
    try:
        e = parse_strict(text)
    except JsonError:
        raise bad() from None
    if not contract.valid("EncryptedVault", e):
        raise bad()
    aad = f"sixkey-vault|1|{e['vaultId']}|{e['vkId']}|{e['rev']}".encode()
    checksum = b64e(sha256(aad, b64d(e["iv"]), b64d(e["ciphertext"])))
    if not hmac.compare_digest(checksum, e["checksum"]):
        raise bad()
    return Envelope(text, e["vaultId"], e["vkId"], e["rev"], e["checksum"], len(raw), sha256(raw))


# ---------------------------------------------------------------------------------------- KeyBundle


@dataclass(frozen=True)
class Bundle:
    text: str
    obj: dict

    @property
    def kver(self) -> int:
        return self.obj["kver"]

    @property
    def vault_id(self) -> str:
        return self.obj["vaultId"]

    @property
    def vk_id(self) -> str:
        return self.obj["keyring"]["vkId"]

    @property
    def by(self) -> str:
        return self.obj["by"]

    def wrap(self, method: str) -> dict:
        return next(w for w in self.obj["keyring"]["wraps"] if w["method"] == method)


def bundle(contract: Contract, text: str) -> Bundle:
    """KeyBundle text: strict JSON, shape, and the rules the schema cannot express (§2.3, §3.13).

    Unknown members are kept (they are under the MAC, §2.3). The server never re-serializes it.
    """
    try:
        b = parse_strict(text)
    except JsonError:
        raise bad() from None
    if not contract.valid("KeyBundle", b):
        raise bad()
    kr = b["keyring"]
    if b["vaultId"] != kr["vaultId"]:
        raise bad()
    methods = sorted(w["method"] for w in kr["wraps"])
    if methods != ["password", "recovery"]:
        raise bad()
    if any(w["vkId"] != kr["vkId"] for w in kr["wraps"]):
        raise bad()
    times = [b["at"]] + [w["createdAt"] for w in kr["wraps"]] + [p["createdAt"] for p in kr["previous"]]
    if any(t % HOUR_MS for t in times):  # §2.3 N16 (also in the schema; kept as a code rule)
        raise bad()
    return Bundle(text, b)


def kver_in_range(if_kver: int, kver: int) -> bool:
    """§2.3 F-01, N27: if_kver < kver <= if_kver + KVER_MAX_JUMP."""
    return if_kver < kver <= if_kver + KVER_MAX_JUMP


def _wrap_changed(old: dict, new: dict) -> bool:
    """S-2: a wrap changed when its iv or wrapped bytes did; createdAt and other members do not count."""
    return b64d(old["iv"]) != b64d(new["iv"]) or b64d(old["wrapped"]) != b64d(new["wrapped"])


def _kdf_text(b: Bundle) -> str:
    return json.dumps(b.obj["auth"]["kdf"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def p4(stored: Bundle, new: Bundle, has_recovery_verifier: bool, has_password_verifier: bool) -> None:
    """§2.3 P4: recovery wrap changed <=> recovery_verifier; password wrap changed <=> auth.kdf changed
    <=> password_verifier. Anything else is 422."""
    rec = _wrap_changed(stored.wrap("recovery"), new.wrap("recovery"))
    pw = _wrap_changed(stored.wrap("password"), new.wrap("password"))
    auth = _kdf_text(stored) != _kdf_text(new)
    if pw != auth or rec != has_recovery_verifier or pw != has_password_verifier:
        raise bad()


# ---------------------------------------------------------------------------------------- names


def name_ct(value: Any, vk_id: str) -> str:
    """A NameCt object (already schema-checked) under the given VK, as stored text."""
    if not isinstance(value, dict) or value.get("vkId") != vk_id:
        raise bad()
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
