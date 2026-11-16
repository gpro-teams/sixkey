"""Log scan (§5.6, §8.4 "日志扫描"), run after everything else: every record any server-side logger
emitted during the session, and the Postgres server log written during the session, must contain no
IP address (real or forged X-Forwarded-For), no email, no OTP, no token, no signature or header value,
no envelope/bundle/verifier/proof material, no base64 run longer than 40 characters, no
'DETAIL: Failing row', and request lines carry seconds-precision times only."""

from __future__ import annotations

import json
import os
import re

import pytest

import pgutil
import sk
from conftest import COLLECTOR, FULL_RUN, PG_LOG_START
from sixkey_server.applog import ALLOWED
from sixkey_server.errors import STATUS

ROUTES = set(sk.OPENAPI["paths"]) | {"-"}

CLIENT_SIDE = ("httpx", "httpcore", "hpack", "hypothesis")
IPV4 = re.compile(r"(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
LONG_B64 = re.compile(r"[A-Za-z0-9+/_=-]{41,}")
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{5,}\.")
FORBIDDEN = (
    "authorization",
    "bearer",
    "sixkey-sig",
    "sixkey-new-sig",
    "sixkey-ts",
    "detail:",
    "failing row",
    "x-forwarded-for",
    "user-agent",
    "traceback",
)
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
DEVICE_ID = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])")
SECONDS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")


def server_records():
    return [(n, t) for n, _, t in COLLECTOR.records if not n.startswith(CLIENT_SIDE)]


def problems(text: str) -> list[str]:
    out = []
    low = text.lower()
    out += [f"forbidden {f!r}" for f in FORBIDDEN if f in low]
    if IPV4.search(text):
        out.append("IPv4 " + IPV4.search(text).group(0))
    if EMAIL.search(text):
        out.append("email")
    if LONG_B64.search(text):
        out.append("long base64 " + LONG_B64.search(text).group(0)[:12])
    if JWT.search(text):
        out.append("JWT")
    if UUID.search(text):
        out.append("uuid (user or request id)")
    if DEVICE_ID.search(text):
        out.append("device id")
    hits = set(TOKEN.findall(text)) & secret_tokens()
    if hits:
        out.append(f"{len(hits)} test secrets, e.g. {sorted(hits)[0][:8]}...")
    return out


TOKEN = re.compile(r"[A-Za-z0-9+/_-]{6,}")
_SECRET_TOKENS: dict[int, set[str]] = {}


def secret_tokens() -> set[str]:
    """Every registered secret as whole tokens: short ones (OTP codes) entire, long ones (keys, proofs,
    signatures, envelope and bundle texts) by their random runs of 12+ characters."""
    if _SECRET_TOKENS.get(len(sk.SECRETS)) is None:
        out: set[str] = set()
        for s_ in sk.SECRETS:
            if TOKEN.fullmatch(s_) and len(s_) <= 16:
                out.add(s_)
            for t in TOKEN.findall(s_):
                if len(t) >= 12 and re.search(r"[0-9]", t) and re.search(r"[A-Za-z]", t):
                    out.add(t)
        _SECRET_TOKENS.clear()
        _SECRET_TOKENS[len(sk.SECRETS)] = out
    return _SECRET_TOKENS[len(sk.SECRETS)]


def test_server_logs_hold_nothing_sensitive():
    recs = server_records()
    if FULL_RUN["value"]:
        assert sum(1 for n, _ in recs if n == "sixkey") > 1000  # the scan really saw the traffic
        assert len(sk.SECRETS) > 1000
    bad = [(n, p, t[:120]) for n, t in recs for p in problems(t)]
    assert bad == [], bad[:5]


def test_request_lines_have_only_the_allowed_fields_at_second_precision():
    lines = [t for n, t in server_records() if n == "sixkey"]
    assert lines
    for t in lines:
        rec = json.loads(t)
        assert set(rec) <= set(ALLOWED), rec
        assert SECONDS.match(rec["t"]), rec["t"]
        if "route" in rec:
            assert "{" in rec["route"] or rec["route"] in ("/healthz", "-") or "/v1/" in rec["route"]
            assert not re.search(r"/[A-Za-z0-9_-]{22}(/|$)|[0-9a-f]{8}-[0-9a-f]{4}-", rec["route"]), rec["route"]
        if "ref" in rec:
            assert re.fullmatch(r"[0-9a-f]{8}", rec["ref"]) and rec["status"] >= 500
        # and every value is one of the expected ones, never request data (review R16)
        assert set(rec) - {"t"} <= set(ALLOWED)
        if "route" in rec:
            assert rec["route"] in ROUTES, rec["route"]
        if "method" in rec:
            assert rec["method"] in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"), rec["method"]
        if "code" in rec:
            assert rec["code"] in STATUS, rec["code"]
        if "exc" in rec:
            assert re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,60}", rec["exc"]), rec["exc"]
        if "event" in rec:
            assert rec["event"] in ("unhandled", "warning_no_trusted_proxy")
        assert isinstance(rec.get("status", 0), int) and isinstance(rec.get("ms", 0), int)
        assert "rid" not in rec or re.fullmatch(r"[0-9a-f]{12}", rec["rid"])
    if FULL_RUN["value"]:
        assert any("ref" in json.loads(t) for t in lines)  # a 5xx with a known account carries its reference


def test_postgres_server_log_holds_no_row_data():
    if not os.path.exists(pgutil.PG_LOG):
        pytest.skip("no local Postgres log (SIXKEY_TEST_ADMIN_DSN points elsewhere)")
    with open(pgutil.PG_LOG, encoding="utf-8", errors="replace") as f:
        f.seek(PG_LOG_START)
        text = f.read()
    # S8: expected conflicts (one_per_session, device_exists, concurrent init) are decided with
    # ON CONFLICT DO NOTHING, so they never become ERRORs whose DETAIL would carry ids
    assert "duplicate key value" not in text
    for line in text.splitlines():
        low = line.lower()
        assert "detail:" not in low and "failing row" not in low and "key (" not in low, line[:160]
        assert not EMAIL.search(line), line[:160]
        assert not set(TOKEN.findall(line)) & secret_tokens(), line[:160]
