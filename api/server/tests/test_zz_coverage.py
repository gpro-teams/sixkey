"""Coverage of the contract by the whole suite (runs last; skipped unless every test file ran).

- Every one of the 29 operations answered at least one request with a 2xx, schema-checked.
- Every (operation, status, error code) the contract lists in x-sixkey-errors was observed, or is in
  UNREACHABLE below with the reason it cannot happen. Every error code of x-sixkey-error-codes was
  observed somewhere (internal_error and unavailable through fault injection).
"""

from __future__ import annotations

import pytest

import sk
from conftest import FULL_RUN

DEVICE_SIGNED_NO_VAULT = (
    "A device row exists only together with its account's vault (init inserts both in one "
    "transaction; neither is deleted except by the auth-user cascade, which removes the device "
    "too, so the next request is 401 unknown_device)"
)
UNREACHABLE: dict[tuple[str, str, str], str] = {
    **{
        (op, "404", "no_vault"): DEVICE_SIGNED_NO_VAULT
        for op in (
            "getSyncStatus",
            "getVault",
            "putVault",
            "listVaultVersions",
            "deleteVaultVersions",
            "getVaultVersion",
            "getKeys",
            "putKeys",
            "rotateKeys",
        )
    },
}


def listed() -> set[tuple[str, str, str]]:
    out = set()
    for p, item in sk.OPENAPI["paths"].items():
        for m, op in item.items():
            for status, codes in op["x-sixkey-errors"].items():
                for c in codes:
                    out.add((op["operationId"], status, c))
    return out


@pytest.fixture(autouse=True)
def only_full_runs():
    if not FULL_RUN["value"]:
        pytest.skip("coverage is only meaningful when the whole suite ran")


def test_every_operation_succeeded_at_least_once():
    ops = {op["operationId"] for item in sk.OPENAPI["paths"].values() for op in item.values()}
    assert len(ops) == 29
    assert ops - sk.SEEN_OPS_2XX == set()


def test_every_listed_error_was_observed_or_is_documented_unreachable():
    seen = {(oid, str(st), c) for oid, st, c in sk.SEEN if c}
    missing = sorted(listed() - seen - set(UNREACHABLE))
    assert missing == [], f"{len(missing)} listed (operation, status, code) not exercised: {missing}"
    stale = sorted(set(UNREACHABLE) & seen)
    assert stale == [], f"documented unreachable but observed: {stale}"


def test_every_error_code_was_observed():
    seen_codes = {c for _, _, c in sk.SEEN if c}
    assert set(sk.OPENAPI["x-sixkey-error-codes"]) - seen_codes == set()
